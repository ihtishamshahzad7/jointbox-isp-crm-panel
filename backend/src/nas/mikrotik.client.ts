import * as net from 'net';

export interface MikrotikConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  timeout?: number;
}

export interface MikrotikResponse {
  [key: string]: string;
}

export class MikrotikClient {
  private socket: net.Socket | null = null;
  private config: MikrotikConfig;
  private buffer: Buffer = Buffer.alloc(0);
  private responseQueue: Array<{
    resolve: (data: MikrotikResponse[]) => void;
    reject: (err: Error) => void;
    rows: MikrotikResponse[];
    current: MikrotikResponse;
    /**
     * A !trap/!fatal has been seen for this request but its reason has not
     * arrived yet. RouterOS sends the error as THREE separate words:
     *
     *   !trap
     *   =message=not enough permissions (9)
     *   !done
     *
     * so the reject must be deferred until !done, or the reason is lost.
     */
    trapped?: boolean;
    trapWord?: string;
    trapMessage?: string;
  }> = [];

  constructor(config: MikrotikConfig) {
    this.config = { timeout: 10000, ...config };
  }

  private encodeLength(len: number): Buffer {
    if (len < 0x80) return Buffer.from([len]);
    if (len < 0x4000) return Buffer.from([(len >> 8) | 0x80, len & 0xff]);
    if (len < 0x200000)
      return Buffer.from([(len >> 16) | 0xc0, (len >> 8) & 0xff, len & 0xff]);
    return Buffer.from([
      (len >> 24) | 0xe0,
      (len >> 16) & 0xff,
      (len >> 8) & 0xff,
      len & 0xff,
    ]);
  }

  private encodeWord(word: string): Buffer {
    const wordBuf = Buffer.from(word, 'utf8');
    return Buffer.concat([this.encodeLength(wordBuf.length), wordBuf]);
  }

  private encodeSentence(words: string[]): Buffer {
    const parts = words.map((w) => this.encodeWord(w));
    parts.push(Buffer.from([0]));
    return Buffer.concat(parts);
  }

  private decodeLength(buf: Buffer, offset: number): { len: number; advance: number } {
    const b = buf[offset];
    if ((b & 0xe0) === 0xe0) return { len: ((b & 0x1f) << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3], advance: 4 };
    if ((b & 0xc0) === 0xc0) return { len: ((b & 0x3f) << 16) | (buf[offset + 1] << 8) | buf[offset + 2], advance: 3 };
    if ((b & 0x80) === 0x80) return { len: ((b & 0x7f) << 8) | buf[offset + 1], advance: 2 };
    return { len: b, advance: 1 };
  }

  /**
   * A readable error for a trapped request, including RouterOS's own reason
   * and a hint for the cause that actually bites in practice.
   */
  private trapError(pending: { trapWord?: string; trapMessage?: string }): string {
    const base = `RouterOS error: ${pending.trapWord ?? '!trap'}`;
    if (!pending.trapMessage) {
      return `${base} (no reason given by the router)`;
    }
    let msg = `${base}: ${pending.trapMessage}`;
    // By far the most common cause, and the least obvious from the raw text:
    // the API user's GROUP is missing a policy, not the user's password.
    if (/permission/i.test(pending.trapMessage)) {
      msg +=
        ` — the API user "${this.config.username}" is connected and authenticated, but its` +
        ` GROUP lacks the required policy. In Winbox: System → Users → Groups,` +
        ` grant at least: api, read, write, test.`;
    }
    return msg;
  }

  /**
   * Fail every in-flight request when the socket goes away.
   *
   * Without this, a !fatal (which closes the connection WITHOUT sending a
   * !done) or any mid-command disconnect left the promises pending forever —
   * the caller simply hung until some outer timeout, with no error to log.
   */
  private failPending(err: Error): void {
    const queued = this.responseQueue;
    this.responseQueue = [];
    for (const p of queued) {
      p.reject(p.trapped ? new Error(this.trapError(p)) : err);
    }
  }

  private processBuffer(): void {
    let offset = 0;
    while (offset < this.buffer.length && this.responseQueue.length > 0) {
      const { len, advance } = this.decodeLength(this.buffer, offset);
      offset += advance;

      if (len === 0) continue;

      if (offset + len > this.buffer.length) {
        offset -= advance;
        break;
      }

      const word = this.buffer.slice(offset, offset + len).toString('utf8');
      offset += len;

      const pending = this.responseQueue[0];

      if (word === '!done') {
        this.responseQueue.shift();
        if (pending.trapped) {
          // The error reason has now arrived (or there wasn't one).
          pending.reject(new Error(this.trapError(pending)));
        } else {
          if (Object.keys(pending.current).length > 0) {
            pending.rows.push({ ...pending.current });
          }
          pending.resolve(pending.rows);
        }
      } else if (word === '!re') {
        if (Object.keys(pending.current).length > 0) {
          pending.rows.push({ ...pending.current });
          pending.current = {};
        }
      } else if (word === '!trap' || word === '!fatal') {
        // TWO BUGS FIXED HERE.
        //
        // 1. It rejected with the bare word — "RouterOS error: !trap" — and
        //    threw away the `=message=` word that follows, which is the only
        //    part that says WHY. Every permission error, bad argument and
        //    unknown command produced the same useless string, making these
        //    failures effectively undiagnosable from the logs.
        //
        // 2. It shifted the queue immediately, but RouterOS still sends a
        //    !done to close the failed request. That !done then landed on the
        //    NEXT queued command and resolved it early with an empty row set —
        //    so a command following a trap silently returned "no results"
        //    instead of running. That is indistinguishable from "no active
        //    sessions", which is precisely the kind of false negative that
        //    made disconnects look like they had succeeded.
        //
        // Both are fixed by deferring: mark the request trapped, collect the
        // reason, and reject when its own !done arrives.
        pending.trapped = true;
        pending.trapWord = word;
      } else if (word.startsWith('=')) {
        const eqIdx = word.indexOf('=', 1);
        if (eqIdx !== -1) {
          const key = word.slice(1, eqIdx);
          const val = word.slice(eqIdx + 1);
          if (pending.trapped) {
            // Attributes after a trap describe the error, not a data row.
            if (key === 'message') pending.trapMessage = val;
          } else {
            pending.current[key] = val;
          }
        }
      }
    }
    this.buffer = this.buffer.slice(offset);
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      this.socket.setTimeout(this.config.timeout!);

      this.socket.on('data', (data: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, data]);
        this.processBuffer();
      });

      this.socket.on('timeout', () => {
        // Fail in-flight commands too, not just the connect promise — a
        // half-open socket used to hang every queued request indefinitely.
        this.failPending(new Error(`RouterOS ${this.config.host}: connection timed out`));
        this.socket?.destroy();
        reject(new Error('Connection timeout'));
      });

      this.socket.on('error', (err) => {
        this.failPending(err);
        reject(err);
      });

      // A !fatal closes the connection without a !done. Surface the reason the
      // router gave rather than letting the caller wait forever.
      this.socket.on('close', () => {
        this.failPending(new Error(`RouterOS ${this.config.host}: connection closed by the router`));
      });

      this.socket.connect(this.config.port, this.config.host, async () => {
        try {
          await this.login();
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  private async login(): Promise<void> {
    const res = await this.send([
      '/login',
      `=name=${this.config.username}`,
      `=password=${this.config.password}`,
    ]);

    if (res[0]?.ret) {
      const crypto = await import('crypto');
      const challenge = Buffer.from(res[0].ret, 'hex');
      const md5 = crypto.createHash('md5');
      md5.update(Buffer.from('\x00'));
      md5.update(Buffer.from(this.config.password));
      md5.update(challenge);
      const response = md5.digest('hex');
      await this.send([
        '/login',
        `=name=${this.config.username}`,
        `=response=00${response}`,
      ]);
    }
  }

  send(words: string[]): Promise<MikrotikResponse[]> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Not connected'));
        return;
      }
      this.responseQueue.push({ resolve, reject, rows: [], current: {} });
      const sentence = this.encodeSentence(words);
      this.socket.write(sentence);
    });
  }

  disconnect(): void {
    // Clear the queue BEFORE destroying the socket: destroy() fires 'close',
    // whose handler would otherwise reject requests that completed normally.
    this.responseQueue = [];
    this.socket?.destroy();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
  }
}

export async function withMikrotik<T>(
  config: MikrotikConfig,
  fn: (client: MikrotikClient) => Promise<T>,
): Promise<T> {
  const client = new MikrotikClient(config);
  try {
    await client.connect();
    const result = await fn(client);
    return result;
  } finally {
    client.disconnect();
  }
}