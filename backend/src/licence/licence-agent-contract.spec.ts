import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { LicenceService, Entitlement } from './licence.service';

/**
 * THE GO ↔ TYPESCRIPT CONTRACT, pinned with the agent's real output.
 *
 * licence.service.spec.ts signs its test responses in TypeScript, which proves
 * the verifier agrees with itself. It cannot catch the verifier disagreeing
 * with the AGENT — and that disagreement is exactly what broke cap
 * enforcement: the agent dropped the cap fields, and the panel's payload list
 * had no slot for them either, so neither side could be fixed alone.
 *
 * The lines below are byte-for-byte what jointbox-licensed 1.1.0 writes to
 * the socket, produced by the agent's own SignV() with a fixed session key.
 * If either side changes the layout, these stop verifying.
 *
 *   v1         what the agent sends a panel that does not ask for v2 — the
 *              same bytes agent 1.0.0 sent, which every installed panel checks
 *   v2         the same licence with its cap policy: 800 sold, 10% overage
 *              (cap_hard 880), 5 routers
 *   suspended  a licence the licence server has suspended
 *
 * The company name is "Ahmed & Sons <ISP>" on purpose; see the HTML-escaping
 * note in verifySignature.
 */
const WIRE = {
  v1: String.raw`{"state":"ACTIVE","plan":"basic","max_subs":800,"feat":["coa","radius"],"company":"Ahmed \u0026 Sons \u003cISP\u003e","trial":false,"exp":1790000000,"grace_ends":1790172800,"licensed":true,"writable":true,"message":"","nonce":"nonce-v1","session_pub":"a977cc9b16456e237a010dbe3e08752aeb7e555849c51e955f235f16689f2c45","sig":"be34abbc92aa90944ab9209f2d9c9b2eafd7962072ab5a29eddbbbb645ca8af5a2f9721f783a82dbe69b37849933a072ce0f0f52acb02736f208ba7deb07a40a"}`,
  v2: String.raw`{"state":"ACTIVE","plan":"basic","max_subs":800,"max_nas":5,"cap_action":"overage","cap_hard":880,"feat":["coa","radius"],"company":"Ahmed \u0026 Sons \u003cISP\u003e","trial":false,"exp":1790000000,"grace_ends":1790172800,"licensed":true,"writable":true,"message":"","nonce":"nonce-v2","session_pub":"a977cc9b16456e237a010dbe3e08752aeb7e555849c51e955f235f16689f2c45","sig":"79971f35fdad24c3d653d0081eb2bde7f760febb9454d78256e0b339746ba3b0eae8c745c841feb92c013ce57e9d558452c611f40f3445f22743fd7b84e2fa08"}`,
  suspended: String.raw`{"state":"SUSPENDED","plan":"basic","max_subs":800,"max_nas":5,"cap_action":"overage","cap_hard":880,"feat":["coa","radius"],"company":"Ahmed \u0026 Sons \u003cISP\u003e","trial":false,"exp":1790000000,"grace_ends":1790172800,"licensed":false,"writable":false,"message":"This licence is suspended. Please contact support. The panel is read-only; subscriber authentication is unaffected.","nonce":"nonce-sus","session_pub":"a977cc9b16456e237a010dbe3e08752aeb7e555849c51e955f235f16689f2c45","sig":"f6bbac9f52ff388a499886bd504a0e2ea2da91fd600489bb7404351f912dd48eb4374ef3835d11666b74c8a7aac9c7f835ff1392e673fe634cac1d306e4f0000"}`,
};

function parse(k: keyof typeof WIRE): Entitlement {
  return JSON.parse(WIRE[k]) as Entitlement;
}

function verify(svc: LicenceService, r: Entitlement, nonce: string): boolean {
  return (svc as any).verifySignature(r, nonce);
}

describe('agent 1.1 wire format', () => {
  const svc = new LicenceService();

  it('verifies a v1 answer (older panels and older agents)', () => {
    const r = parse('v1');
    expect(r.cap_hard).toBeUndefined();
    expect(verify(svc, r, 'nonce-v1')).toBe(true);
  });

  it('verifies a v2 answer and exposes the signed cap policy', () => {
    const r = parse('v2');
    expect(verify(svc, r, 'nonce-v2')).toBe(true);
    (svc as any).current = r;
    expect(svc.capHard).toBe(880);
    expect(svc.capAction).toBe('overage');
    expect(svc.maxNas).toBe(5);
    expect(svc.maxSubscribers).toBe(800);
    expect(svc.company).toBe('Ahmed & Sons <ISP>');
  });

  it.each([
    ['cap_hard raised', { cap_hard: 99999 }],
    ['cap_action softened', { cap_action: 'warn' }],
    ['NAS cap removed', { max_nas: undefined }],
    [
      'whole policy stripped (downgrade to v1)',
      { max_nas: undefined, cap_action: undefined, cap_hard: undefined },
    ],
  ])('REJECTS a v2 answer with %s', (_label, edit) => {
    const r = { ...parse('v2'), ...edit } as Entitlement;
    expect(verify(svc, r, 'nonce-v2')).toBe(false);
  });

  it('REJECTS cap fields added to a v1 answer', () => {
    const r = {
      ...parse('v1'),
      cap_action: 'block',
      cap_hard: 1,
    } as Entitlement;
    expect(verify(svc, r, 'nonce-v1')).toBe(false);
  });

  it('verifies a suspension and makes the panel read-only with the server message', () => {
    const r = parse('suspended');
    expect(verify(svc, r, 'nonce-sus')).toBe(true);
    const s = new LicenceService();
    (s as any).current = r;
    expect(s.state).toBe('SUSPENDED');
    expect(s.licensed).toBe(false);
    expect(s.writable).toBe(false);
    expect(s.banner.level).toBe('error');
    expect(s.banner.message).toContain('suspended');
    expect(s.banner.message).toContain('unaffected');
  });

  it('REJECTS a suspension edited back to ACTIVE', () => {
    const r = {
      ...parse('suspended'),
      state: 'ACTIVE',
      licensed: true,
      writable: true,
    } as Entitlement;
    expect(verify(svc, r, 'nonce-sus')).toBe(false);
  });
});

describe('counts handed to the agent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jbx-counts-'));
  const prev = process.env.JBX_RUN_DIR;

  afterAll(() => {
    if (prev === undefined) delete process.env.JBX_RUN_DIR;
    else process.env.JBX_RUN_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes dealers and companies when known, and omits them when not', () => {
    jest.isolateModules(() => {
      process.env.JBX_RUN_DIR = dir;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { LicenceService: Fresh } = require('./licence.service');
      const s = new Fresh();

      s.publishCounts(20, 2, 3, 1);
      expect(
        JSON.parse(fs.readFileSync(path.join(dir, 'counts.json'), 'utf8')),
      ).toEqual({
        subscribers: 20,
        nas: 2,
        dealers: 3,
        companies: 1,
      });
      expect(s.usage).toMatchObject({
        subscribers: 20,
        nas: 2,
        dealers: 3,
        companies: 1,
      });

      // An older caller: the agent must read "not reported", not "zero".
      s.publishCounts(20, 2);
      const raw = JSON.parse(
        fs.readFileSync(path.join(dir, 'counts.json'), 'utf8'),
      );
      expect(raw).toEqual({ subscribers: 20, nas: 2 });
      expect('dealers' in raw).toBe(false);
    });
  });
});

describe('the request the panel sends', () => {
  it('asks for payload v2 with a fresh nonce', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jbx-sock-'));
    const sockPath = path.join(dir, 'licensed.sock');
    let request = '';
    const server = net.createServer((c) => {
      c.on('data', (d) => {
        request += d.toString();
        c.end('not-json\n'); // the reply is irrelevant here
      });
    });
    await new Promise<void>((r) => server.listen(sockPath, r));

    const prev = process.env.JBX_LICENCE_SOCKET;
    try {
      await new Promise<void>((resolve, reject) => {
        jest.isolateModules(() => {
          process.env.JBX_LICENCE_SOCKET = sockPath;
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { LicenceService: Fresh } = require('./licence.service');
          (new Fresh() as LicenceService).refresh().then(resolve, reject);
        });
      });
    } finally {
      if (prev === undefined) delete process.env.JBX_LICENCE_SOCKET;
      else process.env.JBX_LICENCE_SOCKET = prev;
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }

    const req = JSON.parse(request.trim());
    expect(req.v).toBe(2);
    expect(req.nonce).toMatch(/^[0-9a-f]{32}$/);
  });
});
