import * as dgram from 'dgram';
import { createHash } from 'crypto';

/**
 * Native RFC 3576 / 5176 RADIUS Dynamic Authorization client.
 *
 * This is VENDOR-AGNOSTIC — it speaks the standard protocol, so the same code
 * disconnects or re-rates a session on MikroTik, Cisco, Juniper, pfSense,
 * vBNG/BiSON, or any RADIUS-speaking OLT/BNG. No external tool (radclient) and
 * no per-vendor API required — just the NAS IP, its CoA port (usually 3799)
 * and the shared secret.
 *
 * Packet codes:
 *   40 Disconnect-Request   41 Disconnect-ACK   42 Disconnect-NAK
 *   43 CoA-Request          44 CoA-ACK          45 CoA-NAK
 */

export const RadiusCode = {
  DisconnectRequest: 40,
  DisconnectAck: 41,
  DisconnectNak: 42,
  CoaRequest: 43,
  CoaAck: 44,
  CoaNak: 45,
} as const;

const ATTR = {
  UserName: 1,
  NasIpAddress: 4,
  FramedIpAddress: 8,
  CallingStationId: 31,
  NasIdentifier: 32,
  AcctSessionId: 44,
  VendorSpecific: 26,
};

export interface CoaSession {
  username?: string | null;
  nasIp?: string | null;         // NAS-IP-Address (the router)
  nasIdentifier?: string | null; // NAS-Identifier (BNGs often match on this)
  framedIp?: string | null;      // customer's leased IP
  acctSessionId?: string | null; // the session key most NASes match on
  callingStationId?: string | null; // MAC
}

function tlv(type: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([type, value.length + 2]), value]);
}

function ipv4ToBuf(ip: string): Buffer | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const b = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    b[i] = n;
  }
  return b;
}

/** MikroTik-Rate-Limit VSA (vendor 14988, type 8) for live speed changes. */
export function mikrotikRateLimit(value: string): Buffer {
  const vendorId = Buffer.alloc(4);
  vendorId.writeUInt32BE(14988, 0);
  const val = Buffer.from(value, 'utf8');
  const vsa = Buffer.concat([Buffer.from([8, val.length + 2]), val]);
  return tlv(ATTR.VendorSpecific, Buffer.concat([vendorId, vsa]));
}

/** Build the session-identifying attributes NASes match a session on. */
export function sessionAttributes(s: CoaSession): Buffer[] {
  const out: Buffer[] = [];
  if (s.username) out.push(tlv(ATTR.UserName, Buffer.from(s.username, 'utf8')));
  if (s.acctSessionId) out.push(tlv(ATTR.AcctSessionId, Buffer.from(s.acctSessionId, 'utf8')));
  if (s.nasIdentifier) out.push(tlv(ATTR.NasIdentifier, Buffer.from(s.nasIdentifier, 'utf8')));
  if (s.nasIp) { const b = ipv4ToBuf(s.nasIp); if (b) out.push(tlv(ATTR.NasIpAddress, b)); }
  if (s.framedIp) { const b = ipv4ToBuf(s.framedIp); if (b) out.push(tlv(ATTR.FramedIpAddress, b)); }
  if (s.callingStationId) out.push(tlv(ATTR.CallingStationId, Buffer.from(s.callingStationId, 'utf8')));
  return out;
}

function buildRequest(code: number, id: number, attrs: Buffer[], secret: string): Buffer {
  const body = Buffer.concat(attrs);
  const length = 20 + body.length;
  const header = Buffer.alloc(4);
  header.writeUInt8(code, 0);
  header.writeUInt8(id & 0xff, 1);
  header.writeUInt16BE(length, 2);
  // Request Authenticator (RFC 5176 §2.3): MD5(code+id+len + 16 zero + attrs + secret)
  const zero = Buffer.alloc(16, 0);
  const auth = createHash('md5')
    .update(Buffer.concat([header, zero, body, Buffer.from(secret, 'utf8')]))
    .digest();
  return Buffer.concat([header, auth, body]);
}

export interface CoaResult {
  ok: boolean;          // true only on an ACK
  code: number | null;  // response code (41/42/44/45) or null on timeout
  type: string;         // 'ACK' | 'NAK' | 'timeout' | 'error'
  message: string;
}

/**
 * Send one CoA/Disconnect request and wait for the ACK/NAK.
 * `attributes` = session identifiers + (for CoA) any change attributes.
 */
export function sendCoa(opts: {
  host: string;
  port?: number;
  secret: string;
  code: number;
  attributes: Buffer[];
  timeoutMs?: number;
}): Promise<CoaResult> {
  const port = opts.port && opts.port > 0 ? opts.port : 3799;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const id = Math.floor(Math.random() * 256);
  const packet = buildRequest(opts.code, id, opts.attributes, opts.secret);

  return new Promise<CoaResult>((resolve) => {
    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = (r: CoaResult) => {
      if (done) return;
      done = true;
      try { socket.close(); } catch { /* ignore */ }
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ ok: false, code: null, type: 'timeout', message: `No CoA response from ${opts.host}:${port} (check reachability, CoA port and shared secret)` }),
      timeoutMs,
    );

    socket.on('message', (msg) => {
      clearTimeout(timer);
      const code = msg.length >= 1 ? msg.readUInt8(0) : null;
      const ack = code === RadiusCode.DisconnectAck || code === RadiusCode.CoaAck;
      const nak = code === RadiusCode.DisconnectNak || code === RadiusCode.CoaNak;
      finish({
        ok: ack,
        code,
        type: ack ? 'ACK' : nak ? 'NAK' : 'error',
        message: ack ? 'Router accepted the request' : nak ? 'Router rejected the request (NAK) — session may already be gone or attributes unmatched' : `Unexpected response code ${code}`,
      });
    });
    socket.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, code: null, type: 'error', message: e.message });
    });

    socket.send(packet, port, opts.host, (err) => {
      if (err) { clearTimeout(timer); finish({ ok: false, code: null, type: 'error', message: err.message }); }
    });
  });
}
