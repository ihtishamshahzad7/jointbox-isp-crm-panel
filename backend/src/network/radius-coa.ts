import * as dgram from 'dgram';
import { createHash, createHmac } from 'crypto';

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
  MessageAuthenticator: 80,
  ErrorCause: 101,
  NasIpAddress: 4,
  FramedIpAddress: 8,
  CallingStationId: 31,
  NasIdentifier: 32,
  AcctSessionId: 44,
  VendorSpecific: 26,
};

export interface CoaSession {
  username?: string | null;
  nasIp?: string | null; // NAS-IP-Address (the router)
  nasIdentifier?: string | null; // NAS-Identifier (BNGs often match on this)
  framedIp?: string | null; // customer's leased IP
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
  if (s.acctSessionId)
    out.push(tlv(ATTR.AcctSessionId, Buffer.from(s.acctSessionId, 'utf8')));
  if (s.nasIdentifier)
    out.push(tlv(ATTR.NasIdentifier, Buffer.from(s.nasIdentifier, 'utf8')));
  if (s.nasIp) {
    const b = ipv4ToBuf(s.nasIp);
    if (b) out.push(tlv(ATTR.NasIpAddress, b));
  }
  if (s.framedIp) {
    const b = ipv4ToBuf(s.framedIp);
    if (b) out.push(tlv(ATTR.FramedIpAddress, b));
  }
  if (s.callingStationId)
    out.push(
      tlv(ATTR.CallingStationId, Buffer.from(s.callingStationId, 'utf8')),
    );
  return out;
}

/**
 * Include Message-Authenticator (attribute 80) in CoA/Disconnect requests.
 * RFC 5176 allows it and the BlastRADIUS guidance (2024) asks for it; a
 * receiver that does not require it ignores it. Set
 * RADIUS_COA_MESSAGE_AUTHENTICATOR=0 only if a specific NAS rejects it.
 */
function withMessageAuthenticator(): boolean {
  return !/^(0|false|no|off)$/i.test(
    String(process.env.RADIUS_COA_MESSAGE_AUTHENTICATOR ?? '').trim(),
  );
}

/**
 * Build a signed CoA-Request / Disconnect-Request.
 *
 *   Message-Authenticator = HMAC-MD5(secret, packet with the authenticator
 *                           field and the attribute's value both zero)
 *   Request Authenticator = MD5(code+id+length + 16 zero octets + attributes
 *                           (including the Message-Authenticator) + secret)
 *
 * The order FreeRADIUS itself uses for these request types; verified against
 * a real FreeRADIUS CoA listener (docs/RADIUS_VAULT.md).
 */
export function buildRequest(
  code: number,
  id: number,
  attrs: Buffer[],
  secret: string,
  messageAuthenticator = withMessageAuthenticator(),
): Buffer {
  const key = Buffer.from(secret, 'utf8');
  const parts = [...attrs];
  if (messageAuthenticator)
    parts.unshift(tlv(ATTR.MessageAuthenticator, Buffer.alloc(16, 0)));
  const body = Buffer.concat(parts);
  const length = 20 + body.length;
  if (length > 4096) throw new Error('CoA request is too large');
  const header = Buffer.alloc(4);
  header.writeUInt8(code, 0);
  header.writeUInt8(id & 0xff, 1);
  header.writeUInt16BE(length, 2);
  const zero = Buffer.alloc(16, 0);
  if (messageAuthenticator) {
    const mac = createHmac('md5', key)
      .update(Buffer.concat([header, zero, body]))
      .digest();
    mac.copy(body, 2); // value of the first attribute (Message-Authenticator)
  }
  const auth = createHash('md5')
    .update(Buffer.concat([header, zero, body, key]))
    .digest();
  return Buffer.concat([header, auth, body]);
}

/**
 * Is this reply really from the router, to THIS request? Same identifier, and
 * Response Authenticator = MD5(code+id+length + request authenticator +
 * attributes + secret). Anything else — a stray or forged datagram — is
 * ignored instead of being taken as an ACK.
 */
export function verifyResponse(
  response: Buffer,
  request: Buffer,
  secret: string,
): boolean {
  if (response.length < 20 || request.length < 20) return false;
  const length = response.readUInt16BE(2);
  if (length < 20 || length > response.length) return false;
  if (response[1] !== request[1]) return false;
  const expected = createHash('md5')
    .update(
      Buffer.concat([
        response.subarray(0, 4),
        request.subarray(4, 20),
        response.subarray(20, length),
        Buffer.from(secret, 'utf8'),
      ]),
    )
    .digest();
  return expected.equals(response.subarray(4, 20));
}

/** RFC 5176 Error-Cause in a NAK, for the operator's message. */
const ERROR_CAUSES: Record<number, string> = {
  401: 'unsupported attribute',
  402: 'missing attribute',
  403: 'NAS identification mismatch',
  404: 'invalid request',
  405: 'unsupported service',
  406: 'unsupported extension',
  407: 'invalid attribute value',
  501: 'administratively prohibited',
  502: 'request not routable',
  503: 'session not found',
  504: 'session context not removable',
  505: 'other proxy processing error',
  506: 'resources unavailable',
  507: 'request initiated',
  508: 'multiple session selection unsupported',
};

function errorCause(response: Buffer): string | null {
  const length = Math.min(response.readUInt16BE(2), response.length);
  for (let i = 20; i + 2 <= length;) {
    const t = response[i];
    const l = response[i + 1];
    if (l < 2) break;
    if (t === ATTR.ErrorCause && l === 6) {
      const v = response.readUInt32BE(i + 2);
      return `${v}${ERROR_CAUSES[v] ? ` ${ERROR_CAUSES[v]}` : ''}`;
    }
    i += l;
  }
  return null;
}

export interface CoaResult {
  ok: boolean; // true only on an ACK
  code: number | null; // response code (41/42/44/45) or null on timeout
  type: string; // 'ACK' | 'NAK' | 'timeout' | 'error'
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
  /** Retransmissions of the SAME packet (same id, same authenticator) on silence. */
  retries?: number;
}): Promise<CoaResult> {
  const port = opts.port && opts.port > 0 ? opts.port : 3799;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const retries = Math.max(0, Math.min(opts.retries ?? 2, 5));
  const id = Math.floor(Math.random() * 256);
  let packet: Buffer;
  try {
    packet = buildRequest(opts.code, id, opts.attributes, opts.secret);
  } catch (e) {
    return Promise.resolve({
      ok: false,
      code: null,
      type: 'error',
      message: (e as Error).message,
    });
  }

  return new Promise<CoaResult>((resolve) => {
    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = (r: CoaResult) => {
      if (done) return;
      done = true;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    // The total wait is split over the original send and its retransmissions,
    // so the caller's timeout stays the upper bound.
    const perTry = Math.max(500, Math.floor(timeoutMs / (retries + 1)));
    let sent = 0;
    let timer: NodeJS.Timeout | null = null;
    let forged = 0;
    const send = () => {
      sent++;
      socket.send(packet, port, opts.host, (err) => {
        if (err) {
          if (timer) clearTimeout(timer);
          finish({
            ok: false,
            code: null,
            type: 'error',
            message: err.message,
          });
        }
      });
      timer = setTimeout(() => {
        if (sent <= retries) send();
        else
          finish({
            ok: false,
            code: null,
            type: 'timeout',
            message: forged
              ? `Replies from ${opts.host}:${port} did not match the shared secret — check the RADIUS secret on the router`
              : `No CoA response from ${opts.host}:${port} (check reachability, CoA port and shared secret)`,
          });
      }, perTry);
    };

    socket.on('message', (msg) => {
      // Only a reply to this request, signed with the router's secret. (Not
      // checked by source address: a router may answer from another of its
      // own addresses; the signature already proves it holds the secret.)
      if (!verifyResponse(msg, packet, opts.secret)) {
        forged++;
        return;
      }
      if (timer) clearTimeout(timer);
      const code = msg.readUInt8(0);
      const ack =
        code === RadiusCode.DisconnectAck || code === RadiusCode.CoaAck;
      const nak =
        code === RadiusCode.DisconnectNak || code === RadiusCode.CoaNak;
      const cause = nak ? errorCause(msg) : null;
      finish({
        ok: ack,
        code,
        type: ack ? 'ACK' : nak ? 'NAK' : 'error',
        message: ack
          ? 'Router accepted the request'
          : nak
            ? `Router rejected the request (NAK${cause ? `: ${cause}` : ''}) — session may already be gone or attributes unmatched`
            : `Unexpected response code ${code}`,
      });
    });
    socket.on('error', (e) => {
      if (timer) clearTimeout(timer);
      finish({ ok: false, code: null, type: 'error', message: e.message });
    });

    send();
  });
}
