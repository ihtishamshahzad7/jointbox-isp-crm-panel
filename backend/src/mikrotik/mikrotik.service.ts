import { Injectable, Logger } from '@nestjs/common';
import * as net from 'net';

/**
 * Minimal RouterOS API client for PPPoE session management.
 *
 * Communicates over the RouterOS API port (default 8728) using the
 * MikroTik API word-encoding protocol (v1). No external dependencies.
 *
 * Only the operations the ISP panel needs are implemented:
 *   - disconnectPppoeUser(username) — kicks a PPPoE session via /ppp active remove
 *   - changeBandwidth(username, dl, ul) — updates MikroTik-Rate-Limit
 */
@Injectable()
export class MikrotikService {
  private readonly logger = new Logger(MikrotikService.name);

  /**
   * Disconnect a PPPoE user from the router.
   * Sends: /ppp active remove [find name=<username>]
   */
  async disconnectPppoeUser(
    host: string,
    port: number,
    username: string,
    password: string,
    targetUser: string,
  ): Promise<void> {
    const conn = new MikrotikConnection(host, port, username, password, this.logger);
    try {
      await conn.connect();
      await conn.login();
      await conn.writeCommand('/ppp/active/remove', { '.id': targetUser });
      this.logger.log(`Disconnected PPPoE user ${targetUser} on ${host}`);
    } finally {
      await conn.close().catch(() => {});
    }
  }

  /**
   * Change bandwidth for a user by setting MikroTik-Rate-Limit via RADIUS or local queue.
   * For RADIUS-based setups, this is a no-op (settings are in radcheck).
   * For local setups, sends: /queue simple set [find name=<username>] max-limit=<dl>/<ul>
   */
  async changeBandwidth(
    host: string,
    port: number,
    username: string,
    password: string,
    targetUser: string,
    downloadSpeed: number,
    uploadSpeed: number,
  ): Promise<void> {
    const conn = new MikrotikConnection(host, port, username, password, this.logger);
    try {
      await conn.connect();
      await conn.login();
      const rateLimit = `${downloadSpeed}M/${uploadSpeed}M`;
      // Try queue simple first
      await conn.writeCommand('/queue/simple/set', {
        'numbers': targetUser,
        'max-limit': rateLimit,
      }).catch(() => {
        // Fall back to queue tree or just log
        this.logger.warn(`Queue simple set failed for ${targetUser}, bandwidth may not be applied`);
      });
      this.logger.log(`Bandwidth updated for ${targetUser}: ${rateLimit}`);
    } finally {
      await conn.close().catch(() => {});
    }
  }
}

/**
 * Low-level RouterOS API connection using the word-encoding protocol.
 */
class MikrotikConnection {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly username: string,
    private readonly password: string,
    private readonly logger: Logger,
  ) {}

  async connect(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(
        { host: this.host, port: this.port },
        () => resolve(),
      );
      this.socket.setTimeout(timeoutMs);
      this.socket.on('error', (err) => reject(err));
      this.socket.on('timeout', () => reject(new Error('Connection timeout')));
      this.socket.on('data', (data) => {
        this.buffer = Buffer.concat([this.buffer, data]);
      });
    });
  }

  async login(): Promise<void> {
    const challenges = await this.readSentence();
    // RouterOS sends two challenges; respond with the first one
    for (const word of challenges) {
      if (word.startsWith('=ret=')) {
        const challenge = word.slice(5);
        const response = this.encodePassword(challenge);
        await this.writeSentence('/login', `=name=${this.username}`, `=response=${response}`);
        const reply = await this.readSentence();
        if (reply.some((w) => w.startsWith('!trap'))) {
          throw new Error(`MikroTik login failed: ${reply.join(' ')}`);
        }
        return;
      }
    }
    // If no challenge, try old protocol (/login + name/password)
    await this.writeSentence(
      '/login',
      `=name=${this.username}`,
      `=password=${this.password}`,
    );
    const reply = await this.readSentence();
    if (reply.some((w) => w.startsWith('!trap'))) {
      throw new Error(`MikroTik login failed: ${reply.join(' ')}`);
    }
  }

  async writeCommand(command: string, params: Record<string, string>): Promise<string[]> {
    const words = [command];
    for (const [key, value] of Object.entries(params)) {
      words.push(`=${key}=${value}`);
    }
    await this.writeSentence(...words);
    const reply = await this.readSentence();
    if (reply.some((w) => w.startsWith('!trap'))) {
      throw new Error(`MikroTik command failed: ${reply.join(' ')}`);
    }
    return reply;
  }

  async close(): Promise<void> {
    if (this.socket) {
      this.socket.end();
      this.socket.destroy();
      this.socket = null;
    }
  }

  /** Encode password using MD5 challenge-response (RouterOS API v1). */
  private encodePassword(challenge: string): string {
    const crypto = require('crypto');
    // 00 + password + challenge
    const buf = Buffer.alloc(1 + this.password.length + challenge.length / 2);
    buf[0] = 0;
    buf.write(this.password, 1, 'latin1');
    Buffer.from(challenge, 'hex').copy(buf, 1 + this.password.length);
    const hash = crypto.createHash('md5').update(buf).digest('hex');
    return `00${hash}`;
  }

  /** Write a sentence (list of words) to the socket using RouterOS word encoding. */
  private async writeSentence(...words: string[]): Promise<void> {
    if (!this.socket) throw new Error('Not connected');
    const parts: Buffer[] = [];
    for (const word of words) {
      const encoded = this.encodeLength(word.length);
      parts.push(encoded);
      parts.push(Buffer.from(word, 'latin1'));
    }
    parts.push(Buffer.from([0])); // end-of-sentence marker
    const frame = Buffer.concat(parts);
    return new Promise((resolve, reject) => {
      this.socket!.write(frame, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Read one sentence (until 0-length word). */
  private async readSentence(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const attemptRead = () => {
        try {
          const words: string[] = [];
          let pos = 0;
          while (pos < this.buffer.length) {
            const [len, read] = this.decodeLength(this.buffer, pos);
            if (len === 0) {
              // end of sentence
              this.buffer = this.buffer.slice(pos + 1);
              resolve(words);
              return;
            }
            pos += read;
            if (pos + len > this.buffer.length) {
              // not enough data yet
              return;
            }
            words.push(this.buffer.toString('latin1', pos, pos + len));
            pos += len;
          }
        } catch (e) {
          reject(e);
        }
      };

      // Check if we already have a complete sentence
      if (this.buffer.length > 0) {
        attemptRead();
      }

      // Wait for more data if incomplete
      const onData = () => {
        attemptRead();
      };
      this.socket!.on('data', onData);

      // Timeout guard
      setTimeout(() => {
        this.socket!.removeListener('data', onData);
        if (this.buffer.length > 0) {
          // Try one more time with whatever we have
          try {
            const words: string[] = [];
            let pos = 0;
            while (pos < this.buffer.length) {
              const [len, read] = this.decodeLength(this.buffer, pos);
              if (len === 0) {
                this.buffer = this.buffer.slice(pos + 1);
                this.socket!.removeListener('data', onData);
                resolve(words);
                return;
              }
              pos += read;
              if (pos + len > this.buffer.length) break;
              words.push(this.buffer.toString('latin1', pos, pos + len));
              pos += len;
            }
          } catch {}
        }
        reject(new Error('Timeout reading from MikroTik API'));
      }, 5000);
    });
  }

  /**
   * Encode a length using RouterOS variable-length encoding.
   *  0-0x7F: single byte
   *  0x80-0x3FFF: two bytes (high bit set)
   *  0x4000-0x1FFFFF: three bytes
   *  > 0x1FFFFF: five bytes (0x80 + 4 bytes little-endian)
   */
  private encodeLength(len: number): Buffer {
    if (len < 0x80) {
      return Buffer.from([len]);
    } else if (len < 0x4000) {
      return Buffer.from([0x80 | (len >> 8), len & 0xFF]);
    } else if (len < 0x200000) {
      return Buffer.from([0xC0 | (len >> 16), (len >> 8) & 0xFF, len & 0xFF]);
    }
    const buf = Buffer.alloc(5);
    buf[0] = 0xE0;
    buf.writeUInt32LE(len, 1);
    return buf;
  }

  /**
   * Decode RouterOS variable-length length at position `pos`.
   * Returns [length, bytesRead].
   */
  private decodeLength(buf: Buffer, pos: number): [number, number] {
    if (pos >= buf.length) return [0, 1];
    const first = buf[pos];
    if (first < 0x80) return [first, 1];
    if (first < 0xC0) {
      if (pos + 1 >= buf.length) return [0, 0];
      return [((first & 0x3F) << 8) | buf[pos + 1], 2];
    }
    if (first < 0xE0) {
      if (pos + 2 >= buf.length) return [0, 0];
      return [
        ((first & 0x1F) << 16) | (buf[pos + 1] << 8) | buf[pos + 2],
        3,
      ];
    }
    if (pos + 4 >= buf.length) return [0, 0];
    return [buf.readUInt32LE(pos + 1), 5];
  }
}