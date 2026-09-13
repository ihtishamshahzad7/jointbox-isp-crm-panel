import {
  classify,
  normaliseNumericHost,
  unmapV6,
  assertDestination,
  safeFetch,
  SsrfBlocked,
} from './outbound-guard';

/**
 * SSRF: THE SERVER MUST NOT FETCH WHAT THE CALLER CANNOT.
 *
 * This box runs Redis on 127.0.0.1:6379, PostgreSQL on 5432, FreeRADIUS, and
 * the backend's own event stream — and it sits on a management LAN full of
 * routers. A webhook URL from a request body that reaches any of those is a
 * full read of infrastructure the caller has no account on.
 *
 * The tests below are the evasion table. Every row is a real, published
 * bypass, and each one is here because a regex-based check passes it.
 */
describe('security: outbound destination guard', () => {
  // ── the evasion table ────────────────────────────────────────────────────
  describe('alternate spellings of 127.0.0.1', () => {
    it.each([
      ['decimal', '2130706433'],
      ['hex', '0x7f000001'],
      ['octal', '017700000001'],
      ['dotted hex', '0x7f.0x0.0x0.0x1'],
      ['dotted octal', '0177.0.0.1'],
      ['linux short form', '127.1'],
      ['three-part short form', '127.0.1'],
    ])('%s: %s normalises into the loopback range', (_label, host) => {
      const norm = normaliseNumericHost(host);
      expect(norm.startsWith('127.')).toBe(true);
      expect(classify(norm, 'EXTERNAL').allowed).toBe(false);
      // And refused even in the permissive profile — no router lives on
      // loopback, so there is no legitimate reason to allow it anywhere.
      expect(classify(norm, 'OPERATOR_NETWORK').allowed).toBe(false);
    });

    it('IPv4-mapped IPv6 is judged as the IPv4 address it carries', () => {
      expect(unmapV6('::ffff:127.0.0.1')).toBe('127.0.0.1');
      expect(unmapV6('::ffff:7f00:1')).toBe('127.0.0.1');
      expect(classify('::ffff:127.0.0.1', 'OPERATOR_NETWORK').allowed).toBe(false);
      expect(classify('::ffff:7f00:1', 'OPERATOR_NETWORK').allowed).toBe(false);
      // The same trick aimed at the metadata service.
      expect(classify('::ffff:169.254.169.254', 'OPERATOR_NETWORK').allowed).toBe(false);
    });

    it('IPv6 loopback and link-local are refused', () => {
      for (const a of ['::1', '::', 'fe80::1', 'ff02::1']) {
        expect(classify(a, 'OPERATOR_NETWORK').allowed).toBe(false);
      }
    });
  });

  // ── cloud metadata: the one that turns SSRF into account takeover ────────
  it('THE BIG ONE: cloud metadata is refused in every profile', () => {
    for (const profile of ['EXTERNAL', 'OPERATOR_NETWORK'] as const) {
      const v = classify('169.254.169.254', profile);
      expect(v.allowed).toBe(false);
      expect(v.why).toMatch(/metadata|link-local/i);
    }
    // The whole /16, not just the famous address.
    expect(classify('169.254.1.1', 'EXTERNAL').allowed).toBe(false);
  });

  // ── the profile distinction, which is the design decision here ───────────
  describe('profiles', () => {
    const PRIVATE = ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.88.20', '100.64.0.1'];

    it('EXTERNAL refuses the operator network — a webhook has no business there', () => {
      for (const a of PRIVATE) expect(classify(a, 'EXTERNAL').allowed).toBe(false);
    });

    it('OPERATOR_NETWORK allows it — this is an ISP CRM and that is where the routers are', () => {
      // If this test ever fails, monitoring, SNMP polling and CoA stop
      // working. That is the failure mode a blanket denylist would have had,
      // and it is why the profile exists.
      for (const a of PRIVATE) expect(classify(a, 'OPERATOR_NETWORK').allowed).toBe(true);
    });

    it('172.15 and 172.32 are PUBLIC — the RFC1918 block is /12, not /8', () => {
      // A range check written as `a === 172` would wrongly block real
      // customers. Off-by-one in the safe direction is still a bug.
      expect(classify('172.15.0.1', 'EXTERNAL').allowed).toBe(true);
      expect(classify('172.32.0.1', 'EXTERNAL').allowed).toBe(true);
      expect(classify('172.16.0.1', 'EXTERNAL').allowed).toBe(false);
    });

    it('ordinary public addresses pass', () => {
      for (const a of ['8.8.8.8', '1.1.1.1', '104.16.0.1', '2606:4700::1111']) {
        expect(classify(a, 'EXTERNAL').allowed).toBe(true);
      }
    });

    it('multicast, broadcast and 0.0.0.0 are refused', () => {
      for (const a of ['224.0.0.1', '239.255.255.250', '255.255.255.255', '0.0.0.0']) {
        expect(classify(a, 'OPERATOR_NETWORK').allowed).toBe(false);
      }
    });
  });

  // ── a hostname must be resolved, not pattern-matched ─────────────────────
  describe('assertDestination', () => {
    it('refuses a DNS name that resolves to loopback', async () => {
      // The name looks entirely ordinary. Only resolution reveals it.
      await expect(assertDestination('localhost', 'EXTERNAL')).rejects.toBeInstanceOf(SsrfBlocked);
    });

    it('refuses non-HTTP schemes outright', async () => {
      for (const u of ['file:///etc/passwd', 'gopher://x/', 'ftp://x/', 'dict://127.0.0.1:6379/']) {
        await expect(assertDestination(u, 'EXTERNAL')).rejects.toBeInstanceOf(SsrfBlocked);
      }
    });

    it('refuses an empty or malformed destination rather than defaulting', async () => {
      await expect(assertDestination('', 'EXTERNAL')).rejects.toBeInstanceOf(SsrfBlocked);
      await expect(assertDestination('http://', 'EXTERNAL')).rejects.toBeInstanceOf(SsrfBlocked);
    });

    it('carries the reason, so the log says what was refused and why', async () => {
      await expect(assertDestination('http://127.0.0.1:6379/', 'EXTERNAL')).rejects.toThrow(
        /loopback/i,
      );
    });

    it('allows a private NAS under OPERATOR_NETWORK and refuses it under EXTERNAL', async () => {
      await expect(assertDestination('192.168.88.20', 'OPERATOR_NETWORK')).resolves.toMatchObject({
        addresses: ['192.168.88.20'],
      });
      await expect(assertDestination('192.168.88.20', 'EXTERNAL')).rejects.toBeInstanceOf(
        SsrfBlocked,
      );
    });
  });

  // ── redirects: the bypass that beats validate-then-fetch ─────────────────
  describe('safeFetch follows redirects through the guard', () => {
    const realFetch = global.fetch;
    afterEach(() => {
      global.fetch = realFetch;
    });

    const respond = (status: number, location?: string) =>
      ({
        status,
        headers: { get: (h: string) => (h.toLowerCase() === 'location' ? (location ?? null) : null) },
      }) as any;

    it('THE BYPASS: a 302 into cloud metadata is refused at the second hop', async () => {
      // This is why validating the URL and handing it to fetch() is not a
      // control: the FIRST url passes, and the request that actually goes out
      // is the one the attacker chose.
      global.fetch = jest.fn(async () =>
        respond(302, 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'),
      ) as any;

      await expect(safeFetch('https://example.com/hook', {}, 'EXTERNAL')).rejects.toThrow(
        /169\.254\.169\.254|metadata|link-local/i,
      );
    });

    it('a redirect to a public address is followed normally', async () => {
      let call = 0;
      global.fetch = jest.fn(async () => {
        call++;
        return call === 1 ? respond(302, 'https://example.org/final') : respond(200);
      }) as any;

      const res = await safeFetch('https://example.com/hook', {}, 'EXTERNAL');
      expect(res.status).toBe(200);
      expect(call).toBe(2);
    });

    it('a redirect loop is cut off rather than spun on forever', async () => {
      global.fetch = jest.fn(async () => respond(302, 'https://example.com/hook')) as any;
      await expect(safeFetch('https://example.com/hook', {}, 'EXTERNAL')).rejects.toThrow(
        /redirect/i,
      );
    });

    it('every hop is validated, not just the first', async () => {
      global.fetch = jest.fn(async () => respond(302, 'http://10.0.0.5/admin')) as any;
      await expect(safeFetch('https://example.com/hook', {}, 'EXTERNAL')).rejects.toThrow(
        /private|RFC1918/i,
      );
    });

    it('fetch is always called with manual redirect handling', async () => {
      const spy = jest.fn(async () => respond(200));
      global.fetch = spy as any;
      await safeFetch('https://example.com/hook', { method: 'POST' }, 'EXTERNAL');
      expect(spy).toHaveBeenCalledWith(
        'https://example.com/hook',
        expect.objectContaining({ redirect: 'manual', method: 'POST' }),
      );
    });
  });
});
