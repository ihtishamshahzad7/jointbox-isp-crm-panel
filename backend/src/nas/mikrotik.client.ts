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
        if (Object.keys(pending.current).length > 0) {
          pending.rows.push({ ...pending.current });
        }
        this.responseQueue.shift();
        pending.resolve(pending.rows);
      } else if (word === '!re') {
        if (Object.keys(pending.current).length > 0) {
          pending.rows.push({ ...pending.current });
          pending.current = {};
        }
      } else if (word === '!trap' || word === '!fatal') {
        this.responseQueue.shift();
        pending.reject(new Error(`RouterOS error: ${word}`));
      } else if (word.startsWith('=')) {
        const eqIdx = word.indexOf('=', 1);
        if (eqIdx !== -1) {
          const key = word.slice(1, eqIdx);
          const val = word.slice(eqIdx + 1);
          pending.current[key] = val;
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
        this.socket?.destroy();
        reject(new Error('Connection timeout'));
      });

      this.socket.on('error', (err) => {
        reject(err);
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
    this.socket?.destroy();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.responseQueue = [];
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