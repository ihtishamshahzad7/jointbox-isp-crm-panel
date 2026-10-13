import * as dgram from 'dgram';
import { createHash, createHmac } from 'crypto';
import {
  buildRequest,
  RadiusCode,
  sendCoa,
  sessionAttributes,
  verifyResponse,
} from './radius-coa';

/**
 * Dynamic Authorization (RFC 5176) packets the panel sends to routers. The
 * same packets are also checked against a real FreeRADIUS CoA listener in the
 * RADIUS vault verification; these pin the arithmetic and the reply handling.
 */
const SECRET = 'Test#Secret-1';

function reply(
  req: Buffer,
  code: number,
  secret = SECRET,
  attrs = Buffer.alloc(0),
): Buffer {
  const hdr = Buffer.alloc(4);
  hdr.writeUInt8(code, 0);
  hdr.writeUInt8(req[1], 1);
  hdr.writeUInt16BE(20 + attrs.length, 2);
  const auth = createHash('md5')
    .update(
      Buffer.concat([hdr, req.subarray(4, 20), attrs, Buffer.from(secret)]),
    )
    .digest();
  return Buffer.concat([hdr, auth, attrs]);
}

async function router(
  handler: (msg: Buffer, n: number, send: (b: Buffer) => void) => void,
) {
  const sock = dgram.createSocket('udp4');
  let n = 0;
  sock.on('message', (msg, r) =>
    handler(msg, ++n, (b) => sock.send(b, r.port, r.address)),
  );
  await new Promise<void>((ok) => sock.bind(0, '127.0.0.1', ok));
  return {
    port: sock.address().port,
    close: () => sock.close(),
    count: () => n,
  };
}

describe('CoA / Disconnect packets', () => {
  it('signs with Message-Authenticator first, then the Request Authenticator over it', () => {
    const attrs = sessionAttributes({
      username: 'u1',
      acctSessionId: 's1',
      nasIp: '10.0.0.1',
    });
    const p = buildRequest(
      RadiusCode.DisconnectRequest,
      7,
      attrs,
      SECRET,
      true,
    );
    expect(p[0]).toBe(40);
    expect(p[20]).toBe(80); // Message-Authenticator is the first attribute
    expect(p[21]).toBe(18);
    const zeroVec = Buffer.concat([
      p.subarray(0, 4),
      Buffer.alloc(16),
      p.subarray(20),
    ]);
    // Request Authenticator = MD5(packet with zero vector, MA filled in, + secret)
    expect(
      createHash('md5')
        .update(Buffer.concat([zeroVec, Buffer.from(SECRET)]))
        .digest(),
    ).toEqual(p.subarray(4, 20));
    // MA = HMAC-MD5 over the packet with vector AND MA value zeroed
    const zeroMa = Buffer.from(zeroVec);
    zeroMa.fill(0, 22, 38);
    expect(createHmac('md5', SECRET).update(zeroMa).digest()).toEqual(
      p.subarray(22, 38),
    );
  });

  it('can leave Message-Authenticator out for a NAS that rejects it', () => {
    process.env.RADIUS_COA_MESSAGE_AUTHENTICATOR = '0';
    try {
      const p = buildRequest(
        RadiusCode.CoaRequest,
        1,
        sessionAttributes({ username: 'u' }),
        SECRET,
      );
      expect(p[20]).toBe(1); // User-Name first, no attribute 80
    } finally {
      delete process.env.RADIUS_COA_MESSAGE_AUTHENTICATOR;
    }
  });

  it('accepts only a reply signed with the secret, to the same request id', () => {
    const req = buildRequest(
      40,
      9,
      sessionAttributes({ username: 'u' }),
      SECRET,
    );
    expect(verifyResponse(reply(req, 41), req, SECRET)).toBe(true);
    expect(verifyResponse(reply(req, 41, 'wrong'), req, SECRET)).toBe(false);
    const other = reply(req, 41);
    other[1] = (req[1] + 1) & 0xff;
    expect(verifyResponse(other, req, SECRET)).toBe(false);
  });

  it('ignores a forged ACK and says the secret does not match', async () => {
    const r = await router((msg, _n, send) =>
      send(reply(msg, 41, 'not-the-secret')),
    );
    try {
      const res = await sendCoa({
        host: '127.0.0.1',
        port: r.port,
        secret: SECRET,
        code: 40,
        attributes: [],
        timeoutMs: 900,
        retries: 1,
      });
      expect(res).toMatchObject({ ok: false, type: 'timeout' });
      expect(res.message).toMatch(/did not match the shared secret/);
    } finally {
      r.close();
    }
  });

  it('retransmits the same packet when the first one is lost', async () => {
    let first: Buffer | null = null;
    const r = await router((msg, n, send) => {
      if (n === 1) {
        first = msg;
        return;
      } // dropped
      expect(msg.equals(first!)).toBe(true); // identical retransmission
      send(reply(msg, 41));
    });
    try {
      const res = await sendCoa({
        host: '127.0.0.1',
        port: r.port,
        secret: SECRET,
        code: 40,
        attributes: [],
        timeoutMs: 1500,
        retries: 2,
      });
      expect(res).toMatchObject({ ok: true, type: 'ACK' });
      expect(r.count()).toBe(2);
    } finally {
      r.close();
    }
  });

  it("reports the router's Error-Cause on a NAK", async () => {
    const cause = Buffer.from([101, 6, 0, 0, 0x01, 0xf7]); // 503
    const r = await router((msg, _n, send) =>
      send(reply(msg, 42, SECRET, cause)),
    );
    try {
      const res = await sendCoa({
        host: '127.0.0.1',
        port: r.port,
        secret: SECRET,
        code: 40,
        attributes: [],
        timeoutMs: 900,
      });
      expect(res).toMatchObject({ ok: false, type: 'NAK' });
      expect(res.message).toMatch(/503 session not found/);
    } finally {
      r.close();
    }
  });
});
