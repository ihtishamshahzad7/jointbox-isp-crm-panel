import * as crypto from 'crypto';
import { LicenceService, licensingDisabled, Entitlement } from './licence.service';

/**
 * The signature check is what makes patching this file detectable. If it ever
 * stops working, the only thing left is an honour system.
 *
 * These tests also pin the Go↔JavaScript serialisation contract. The agent
 * signs JSON with the keys in its Go struct's declaration order and with Go's
 * HTML escaping turned OFF, because JSON.stringify does not escape & < >. Get
 * either wrong and every verification fails — for `&` specifically, every
 * customer trading as "Something & Sons" would be reported as a cracker.
 */

/** Signs exactly as the agent does. */
function makeSigned(
  fields: Partial<Entitlement>,
  nonce: string,
  priv?: crypto.KeyObject,
  pub?: crypto.KeyObject,
): Entitlement {
  let publicKey = pub;
  let privateKey = priv;
  if (!publicKey || !privateKey) {
    const kp = crypto.generateKeyPairSync('ed25519');
    publicKey = kp.publicKey;
    privateKey = kp.privateKey;
  }

  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);

  const r: Entitlement = {
    state: 'ACTIVE',
    plan: 'professional',
    max_subs: 5000,
    feat: ['olt', 'franchise'],
    company: 'Acme Networks',
    trial: false,
    exp: Math.floor(Date.now() / 1000) + 86400,
    grace_ends: Math.floor(Date.now() / 1000) + 86400 * 8,
    licensed: true,
    writable: true,
    message: '',
    nonce,
    session_pub: rawPub.toString('hex'),
    sig: '',
    ...fields,
  };

  const payload = JSON.stringify({
    state: r.state,
    plan: r.plan,
    max_subs: r.max_subs,
    feat: r.feat,
    company: r.company,
    trial: r.trial,
    exp: r.exp,
    grace_ends: r.grace_ends,
    licensed: r.licensed,
    writable: r.writable,
    message: r.message,
    nonce: r.nonce,
    session_pub: r.session_pub,
    sig: '',
  });

  r.sig = crypto.sign(null, Buffer.from(payload), privateKey).toString('hex');
  return r;
}

/** Reaches the private method the way the service itself does. */
function verify(svc: LicenceService, r: Entitlement, nonce: string): boolean {
  return (svc as any).verifySignature(r, nonce);
}

describe('entitlement signature verification', () => {
  let svc: LicenceService;

  beforeEach(() => {
    delete process.env.JBX_LICENCE_ENFORCE;
    svc = new LicenceService();
  });

  it('accepts a genuine response', () => {
    const r = makeSigned({}, 'nonce-1');
    expect(verify(svc, r, 'nonce-1')).toBe(true);
  });

  it('REJECTS a response edited to claim a licence', () => {
    // Exactly what a patched build of this file would produce.
    const r = makeSigned({ state: 'EXPIRED', licensed: false, writable: false }, 'n');
    const forged = { ...r, state: 'ACTIVE' as const, licensed: true, writable: true };
    expect(verify(svc, forged, 'n')).toBe(false);
  });

  it.each([
    ['raised subscriber cap', { max_subs: 9_999_999 }],
    ['upgraded plan', { plan: 'enterprise' }],
    ['extra features', { feat: ['olt', 'multitenant', 'api'] }],
    ['extended expiry', { exp: Math.floor(Date.now() / 1000) + 86400 * 3650 }],
    ['different company', { company: 'Someone Else' }],
    ['flipped writable', { writable: true, licensed: true }],
  ])('rejects a response with a %s', (_label, patch) => {
    const r = makeSigned({ state: 'EXPIRED', licensed: false, writable: false }, 'n');
    expect(verify(svc, { ...r, ...(patch as object) } as Entitlement, 'n')).toBe(false);
  });

  it('rejects a replayed response', () => {
    const captured = makeSigned({}, 'old-nonce');
    expect(verify(svc, captured, 'old-nonce')).toBe(true);
    // The service always asks with a fresh nonce, so a captured ACTIVE answer
    // cannot be served back later.
    expect(verify(svc, captured, 'new-nonce')).toBe(false);
  });

  it.each([
    ['blank signature', { sig: '' }],
    ['garbage signature', { sig: 'zzzz' }],
    ['blank nonce', { nonce: '' }],
    ['truncated key', { session_pub: '00' }],
    ['non-hex key', { session_pub: 'not-hex-at-all' }],
  ])('rejects %s', (_label, patch) => {
    const r = makeSigned({}, 'n');
    expect(verify(svc, { ...r, ...(patch as object) } as Entitlement, 'n')).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const a = makeSigned({}, 'n');
    const b = makeSigned({}, 'n');
    // b's signature over a's payload.
    expect(verify(svc, { ...a, sig: b.sig }, 'n')).toBe(false);
  });

  it('survives malformed input without throwing', () => {
    for (const bad of [null, undefined, {}, 'string', 42, []]) {
      expect(() => verify(svc, bad as any, 'n')).not.toThrow();
      expect(verify(svc, bad as any, 'n')).toBe(false);
    }
  });

  /**
   * REGRESSION. Go's json.Marshal escapes & < > as & < >;
   * JSON.stringify does not. The agent turns that escaping off so the two
   * sides agree. If either end regresses, these fail — which is the point,
   * because the alternative is a real customer being flagged as a cracker
   * for being called "Ahmed & Sons".
   */
  it.each([
    'Ahmed & Sons',
    '<Fibre> Networks',
    'A&B <C> D',
    'Zahid & Co. <ISP>',
    'Quotes "Pvt" Ltd',
    'Aurangzeb Fibre — Lahore',
    'شبکہ انٹرنیٹ',
  ])('verifies for a company named %s', (company) => {
    const r = makeSigned({ company }, 'n');
    expect(verify(svc, r, 'n')).toBe(true);
  });
});

describe('fail-open behaviour', () => {
  beforeEach(() => {
    delete process.env.JBX_LICENCE_ENFORCE;
  });

  it('a service that has never reached the agent is permissive', () => {
    // The agent may not be installed at all — on a self-built panel, or during
    // an upgrade. That must not present as a licensing failure.
    const svc = new LicenceService();
    expect(svc.state).toBe('UNAVAILABLE');
    expect(svc.licensed).toBe(true);
    expect(svc.writable).toBe(true);
    expect(svc.hasFeature('olt')).toBe(true);
  });

  it('refresh() never throws when the socket is missing', async () => {
    process.env.JBX_LICENCE_SOCKET = '/nonexistent/definitely-not-here.sock';
    const svc = new LicenceService();
    await expect(svc.refresh()).resolves.toBeUndefined();
    expect(svc.writable).toBe(true);
    delete process.env.JBX_LICENCE_SOCKET;
  });

  it('status() is safe to call before any contact', () => {
    const svc = new LicenceService();
    const s = svc.status();
    expect(s.state).toBe('UNAVAILABLE');
    expect(s.licensed).toBe(true);
    expect(s.banner).toEqual({ level: 'warn', message: expect.any(String) });
  });
});

describe('the kill switch', () => {
  afterEach(() => {
    delete process.env.JBX_LICENCE_ENFORCE;
  });

  it('JBX_LICENCE_ENFORCE=false reports fully licensed', () => {
    process.env.JBX_LICENCE_ENFORCE = 'false';
    expect(licensingDisabled()).toBe(true);
    const svc = new LicenceService();
    expect(svc.state).toBe('ACTIVE');
    expect(svc.licensed).toBe(true);
    expect(svc.writable).toBe(true);
    expect(svc.hasFeature('anything')).toBe(true);
    expect(svc.banner.level).toBe('none');
    expect(svc.status().enforced).toBe(false);
  });

  it('is off unless set to exactly "false"', () => {
    for (const v of ['true', '0', '', 'FALSE', 'no']) {
      process.env.JBX_LICENCE_ENFORCE = v;
      expect(licensingDisabled()).toBe(false);
    }
  });
});
