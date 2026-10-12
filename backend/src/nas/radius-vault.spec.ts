import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  nasIpProblem,
  confQuote,
  detectClientMode,
  renderClients,
  secretProblem,
  staticClientIps,
  normaliseIp,
  VAULT_INCLUDE_LINE,
} from './radius-clients-render';
import { RadiusClientVaultService } from './radius-client-vault.service';
import { SecretsService } from '../common/secrets.service';
import * as host from './radius-host';

/**
 * Router (NAS) secrets → FreeRADIUS. A wrong client file means no customer
 * can sign in through that router, so these pin the rules down.
 */
const secrets = new SecretsService({} as any);
const enc = (s: string) => secrets.encryptValue(s);
const dec = (p: string) => secrets.decryptValue(p);

describe('rendering the FreeRADIUS router file', () => {
  it('writes active routers only, with the decrypted secret single-quoted', () => {
    const r = renderClients(
      [
        {
          id: 1,
          nasIp: '10.0.0.1',
          shortname: 'Core',
          isActive: true,
          radiusSecretEnc: enc('s3cret'),
        },
        {
          id: 2,
          nasIp: '10.0.0.2',
          shortname: 'Off',
          isActive: false,
          radiusSecretEnc: enc('x'),
        },
      ],
      { decrypt: dec },
    );
    expect(r.clients).toEqual([{ id: 1, ip: '10.0.0.1' }]);
    expect(r.content).toContain('client jointbox-nas-1 {');
    expect(r.content).toContain("secret = 's3cret'");
    expect(r.content).not.toContain('jointbox-nas-2');
  });

  it('leaves out — and says why — routers FreeRADIUS would refuse or that would stop it starting', () => {
    const r = renderClients(
      [
        { id: 1, nasIp: '127.0.0.1', isActive: true, secret: 'a' }, // localhost is in clients.conf
        { id: 2, nasIp: '10.0.0.0/24', isActive: true, secret: 'a' }, // a range, not one router
        { id: 3, nasIp: '10.0.0.3', isActive: true }, // no secret
        { id: 4, nasIp: '10.0.0.4', isActive: true, secret: 'a' },
        { id: 5, nasIp: '10.0.0.4', isActive: true, secret: 'b' }, // same address twice
        { id: 6, nasIp: 'router.local', isActive: true, secret: 'a' },
      ],
      { decrypt: dec, reservedIps: new Set(['127.0.0.1']) },
    );
    expect(r.clients.map((c) => c.id)).toEqual([4]);
    expect(r.skipped.map((s) => s.id).sort()).toEqual([1, 2, 3, 5, 6]);
    expect(r.skipped.find((s) => s.id === 5)?.reason).toMatch(/router #4/);
  });

  it('reports — never writes — a secret that cannot be decrypted (SECRETS_KEY changed)', () => {
    const r = renderClients(
      [
        {
          id: 9,
          nasIp: '10.0.0.9',
          isActive: true,
          radiusSecretEnc: 'not:a:payload',
        },
      ],
      { decrypt: dec },
    );
    expect(r.undecryptable).toEqual([9]);
    expect(r.clients).toEqual([]);
  });

  it('a secret or name cannot break out of the file', () => {
    expect(confQuote("a'b\\c${x}")).toBe("'a\\'b\\\\c${x}'");
    const r = renderClients(
      [
        {
          id: 1,
          nasIp: '10.0.0.1',
          shortname: "x' }\nclient evil {",
          isActive: true,
          secret: 'ok',
        },
      ],
      { decrypt: dec },
    );
    expect(r.content).not.toMatch(/^client evil/m);
    expect(r.content).toMatch(/^\tshortname = '[^'\n]*'$/m);
    expect(r.content.match(/^client /gm)).toHaveLength(1);
  });

  it('secrets FreeRADIUS and routers can hold exactly', () => {
    expect(secretProblem('Abc#123!')).toBeNull();
    expect(secretProblem(' padded')).toMatch(/spaces/);
    expect(secretProblem('tab\there')).toMatch(/letters/);
    expect(secretProblem('x'.repeat(61))).toMatch(/60/);
    expect(normaliseIp('10.1.1.1/32')).toBe('10.1.1.1');
    expect(normaliseIp('10.1.1.0/24')).toBeNull();
  });
});

describe('which source FreeRADIUS reads routers from', () => {
  const stock =
    'client localhost {\n  ipaddr = 127.0.0.1\n  secret = testing123\n}\n';
  it('file only when the file is included by name and SQL does not read clients', () => {
    expect(
      detectClientMode(
        `${stock}\n${VAULT_INCLUDE_LINE}\n`,
        'sql {\n read_clients = no\n}',
      ),
    ).toBe('file');
    expect(
      detectClientMode(
        `${stock}\n${VAULT_INCLUDE_LINE}\n`,
        'sql {\n read_clients = yes\n}',
      ),
    ).toBe('sql');
    // the wildcard form does not work in FreeRADIUS — it is NOT the file mode
    expect(detectClientMode(`${stock}\n$INCLUDE clients.d/*.conf\n`, '')).toBe(
      'sql',
    );
    expect(detectClientMode(stock, '')).toBe('sql');
  });
  it('knows the addresses clients.conf already defines', () => {
    expect([
      ...staticClientIps(
        `${stock}\n# ipaddr = 1.2.3.4\nclient x {\n ipv6addr = ::1\n}`,
      ),
    ]).toEqual(['127.0.0.1', '::1']);
  });
});

describe('the vault keeps FreeRADIUS working', () => {
  const ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ENV };
  });

  function server(mode: 'file' | 'sql') {
    const root = mkdtempSync(join(tmpdir(), 'jbx-rad-'));
    mkdirSync(join(root, 'clients.d'));
    mkdirSync(join(root, 'mods-enabled'));
    writeFileSync(join(root, 'radiusd.conf'), 'user = freerad\n');
    writeFileSync(
      join(root, 'clients.conf'),
      `client localhost {\n ipaddr = 127.0.0.1\n secret = t\n}\n${mode === 'file' ? `${VAULT_INCLUDE_LINE}\n` : ''}`,
    );
    writeFileSync(
      join(root, 'mods-enabled', 'sql'),
      `sql {\n read_clients = ${mode === 'file' ? 'no' : 'yes'}\n}\n`,
    );
    process.env.FREERADIUS_DIR = root;
    process.env.FREERADIUS_RESTART_CMD = 'true';
    process.env.FREERADIUS_STATUS_CMD = 'true';
    process.env.FREERADIUS_CHECK_CMD = 'true';
    process.env.JOINTBOX_RADIUS_LOCK = join(root, 'radius.lock');
    delete process.env.FREERADIUS_CLIENTS_FILE;
    delete process.env.RADIUS_CLIENTS_MODE;
    return { root, file: join(root, 'clients.d', 'jointbox-nas.conf') };
  }

  function prismaWith(rows: any[]) {
    const prisma: any = {
      nas: {
        findMany: jest.fn(async ({ where }: any = {}) =>
          rows.filter((r) => {
            if (!where) return true;
            if (where.isActive === true && !r.isActive) return false;
            if (where.radiusSecretEnc === null && r.radiusSecretEnc)
              return false;
            if (where.radiusSecretEnc?.not === null && !r.radiusSecretEnc)
              return false;
            if (where.secret === null && r.secret) return false;
            if (where.secret?.not === null && !r.secret) return false;
            return true;
          }),
        ),
        update: jest.fn(async ({ where, data }: any) =>
          Object.assign(
            rows.find((r) => r.id === where.id),
            data,
          ),
        ),
        count: jest.fn(
          async (args: any = {}) =>
            (await prisma.nas.findMany(args)).length as number,
        ),
      },
      systemLog: { create: jest.fn().mockResolvedValue({}) },
    };
    return prisma;
  }

  it('file mode: writes 0640, restarts, then clears the plaintext copy', async () => {
    const { file } = server('file');
    const rows = [
      {
        id: 1,
        nasIp: '10.9.0.1',
        shortname: 'A',
        isActive: true,
        secret: 'abc123',
        radiusSecretEnc: null,
      },
    ];
    const v = new RadiusClientVaultService(prismaWith(rows), secrets);
    const r = await v.apply('nas-create');
    expect(r).toMatchObject({
      ok: true,
      mode: 'file',
      changed: true,
      restarted: true,
      clients: 1,
    });
    expect(readFileSync(file, 'utf8')).toContain("secret = 'abc123'");
    expect((statSync(file).mode & 0o777).toString(8)).toBe('640');
    expect(rows[0].secret).toBeNull(); // plaintext gone
    expect(dec(rows[0].radiusSecretEnc as any)).toBe('abc123');
  });

  it('file mode: a config FreeRADIUS rejects is rolled back and reported', async () => {
    const { file } = server('file');
    writeFileSync(file, '# previous good list\n');
    process.env.FREERADIUS_CHECK_CMD =
      'echo "Errors reading clients" >&2; false';
    const restart = (process.env.FREERADIUS_RESTART_CMD =
      'touch /tmp/should-not-exist-jbx');
    const rows = [
      {
        id: 1,
        nasIp: '10.9.0.1',
        isActive: true,
        secret: null,
        radiusSecretEnc: enc('abc123'),
      },
    ];
    const r = await new RadiusClientVaultService(
      prismaWith(rows),
      secrets,
    ).apply('nas-update');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/previous one was kept/);
    expect(readFileSync(file, 'utf8')).toBe('# previous good list\n');
    expect(restart).toBeTruthy();
  });

  it('never drops routers whose secret cannot be decrypted — keeps the old file', async () => {
    const { file } = server('file');
    writeFileSync(file, '# previous good list\n');
    const rows = [
      {
        id: 3,
        nasIp: '10.9.0.3',
        isActive: true,
        secret: null,
        radiusSecretEnc: 'garbage:x:y',
      },
    ];
    const r = await new RadiusClientVaultService(
      prismaWith(rows),
      secrets,
    ).apply('startup');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/cannot be decrypted/);
    expect(readFileSync(file, 'utf8')).toBe('# previous good list\n');
  });

  it('sql mode (server not switched yet): plaintext is kept, and put back where an earlier build cleared it', async () => {
    server('sql');
    const rows = [
      {
        id: 1,
        nasIp: '10.9.0.1',
        isActive: true,
        secret: 'keep-me',
        radiusSecretEnc: null,
      },
      {
        id: 2,
        nasIp: '10.9.0.2',
        isActive: true,
        secret: null,
        radiusSecretEnc: enc('lost-it'),
      },
    ];
    const v = new RadiusClientVaultService(prismaWith(rows), secrets);
    expect(v.mode()).toBe('sql');
    const r = await v.apply('nas-create');
    expect(r.ok).toBe(true);
    expect(rows[0].secret).toBe('keep-me');
    expect(rows[1].secret).toBe('lost-it'); // FreeRADIUS reads this column in sql mode
    expect(rows[0].radiusSecretEnc).toBeTruthy(); // and the vault copy exists too
  });

  it('nothing changed = nothing restarted', async () => {
    const { file } = server('file');
    const rows = [
      {
        id: 1,
        nasIp: '10.9.0.1',
        isActive: true,
        secret: null,
        radiusSecretEnc: enc('abc123'),
      },
    ];
    const v = new RadiusClientVaultService(prismaWith(rows), secrets);
    await v.apply('x');
    const r2 = await v.apply('y');
    expect(r2).toMatchObject({ ok: true, changed: false, restarted: false });
    expect(existsSync(file)).toBe(true);
  });

  it('a burst of router changes is one follow-up sync, not one restart each', async () => {
    const { root } = server('file');
    const count = join(root, 'restarts');
    process.env.FREERADIUS_RESTART_CMD = `echo x >> ${count}`;
    const rows: any[] = [
      {
        id: 1,
        nasIp: '10.9.0.1',
        isActive: true,
        secret: null,
        radiusSecretEnc: enc('a1'),
      },
    ];
    const v = new RadiusClientVaultService(prismaWith(rows), secrets);
    const first = v.apply('nas-create');
    rows.push({
      id: 2,
      nasIp: '10.9.0.2',
      isActive: true,
      secret: null,
      radiusSecretEnc: enc('a2'),
    });
    const burst = await Promise.all([
      v.apply('a'),
      v.apply('b'),
      v.apply('c'),
      v.apply('d'),
    ]);
    await first;
    expect(new Set(burst).size).toBe(1); // all four share one sync
    // at most: the running sync + one follow-up (here the running one already
    // saw router 2, so the follow-up found nothing to restart for)
    expect(
      readFileSync(count, 'utf8').trim().split('\n').length,
    ).toBeLessThanOrEqual(2);
    expect(burst[0].clients).toBe(2);
    expect(
      readFileSync(join(root, 'clients.d', 'jointbox-nas.conf'), 'utf8'),
    ).toContain('jointbox-nas-2');
  });

  it('re-makes a vault copy that no longer decrypts from the kept plaintext', async () => {
    server('sql');
    const rows: any[] = [
      {
        id: 4,
        nasIp: '10.9.0.4',
        isActive: true,
        secret: 'still-here',
        radiusSecretEnc: 'old:key:payload',
      },
    ];
    const v = new RadiusClientVaultService(prismaWith(rows), secrets);
    expect(await v.encryptMissing()).toBe(1);
    expect(dec(rows[0].radiusSecretEnc)).toBe('still-here');
  });

  it('sql mode: never restarts into a configuration FreeRADIUS rejects', async () => {
    const { root } = server('sql');
    const restarted = join(root, 'restarted');
    process.env.FREERADIUS_CHECK_CMD =
      'echo "radiusd.conf[12]: Parse error" >&2; false';
    process.env.FREERADIUS_RESTART_CMD = `touch ${restarted}`;
    const rows = [
      {
        id: 1,
        nasIp: '10.9.0.1',
        isActive: true,
        secret: 'abc',
        radiusSecretEnc: null,
      },
    ];
    const r = await new RadiusClientVaultService(
      prismaWith(rows),
      secrets,
    ).apply('nas-update');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not restarted.*radiusd\.conf\[12\]/);
    expect(existsSync(restarted)).toBe(false);
  });

  it('self-heal: notices a router list that drifted from the database and fixes it', async () => {
    const { file } = server('file');
    const rows: any[] = [
      {
        id: 1,
        nasIp: '10.9.0.1',
        isActive: true,
        secret: null,
        radiusSecretEnc: enc('abc'),
      },
    ];
    const v = new RadiusClientVaultService(prismaWith(rows), secrets);
    await v.apply('x');
    expect(await v.needsSync()).toBe(false);
    writeFileSync(file, '# edited by hand\n');
    expect(await v.needsSync()).toBe(true);
    const r = await v.recheck();
    expect(r?.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain("secret = 'abc'");
    expect(await v.needsSync()).toBe(false);
  });

  it('self-heal does not restart FreeRADIUS over a problem a restart cannot fix', async () => {
    const { file } = server('file');
    writeFileSync(file, '# previous good list\n');
    const rows = [
      {
        id: 3,
        nasIp: '10.9.0.3',
        isActive: true,
        secret: null,
        radiusSecretEnc: 'garbage:x:y',
      },
    ];
    const v = new RadiusClientVaultService(prismaWith(rows), secrets);
    expect((await v.apply('startup')).ok).toBe(false);
    expect(await v.needsSync()).toBe(false); // reported, not retried every 5 minutes
  });
});

describe('router addresses the panel accepts', () => {
  it('refuses what FreeRADIUS could never match a router by', () => {
    expect(nasIpProblem('10.20.30.40')).toBeNull();
    expect(nasIpProblem('010.1.1.1')).toMatch(/leading zeros/);
    expect(nasIpProblem('10.0.0.0/24')).toMatch(/subnet/);
    expect(nasIpProblem('router.local')).toMatch(/not a valid IPv4/);
    expect(nasIpProblem('127.0.0.1')).toMatch(/loopback/);
    expect(nasIpProblem('0.0.0.0')).toMatch(/not a usable/);
    expect(nasIpProblem('224.0.0.5')).toMatch(/multicast/);
  });
});

describe('secrets in FreeRADIUS files shown on screen', () => {
  const conf = [
    'client localhost {',
    '\tipaddr = 127.0.0.1',
    "\tsecret = 'loc-al'",
    '}',
    'client office {',
    '\tipaddr = 10.1.1.1',
    "\tsecret = 'off-ice'",
    '}',
    '#\tpassword = "radpass"',
    '',
  ].join('\n');

  it('never sends a secret value, and a save keeps each one in its place', () => {
    const shown = host.redactConfig(conf);
    expect(shown).not.toMatch(/loc-al|off-ice/);
    expect(shown).toContain('#\tpassword = "radpass"'); // comments untouched
    // the operator deletes the first client and edits the other's address
    const edited = shown
      .replace(/client localhost \{[\s\S]*?\}\n/, '')
      .replace('10.1.1.1', '10.1.1.2');
    const back = host.unredactConfig(edited, conf);
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.text).toContain("secret = 'off-ice'"); // not localhost's
      expect(back.text).toContain('ipaddr = 10.1.1.2');
    }
  });

  it('refuses to write the placeholder itself as a secret', () => {
    const back = host.unredactConfig(
      `${host.redactConfig(conf)}client new {\n\tsecret = <hidden>\n}\n`,
      conf,
    );
    expect(back.ok).toBe(false);
  });

  it('hides secrets in check output too', () => {
    expect(host.hideSecrets("secret = 'abc' # x")).toBe('secret = <hidden>');
    expect(
      host.checkErrors('/etc/x/clients.conf[3]: Unknown\nother error here\n'),
    ).toMatch(/^\/etc\/x\/clients\.conf\[3\]: Unknown/);
  });
});

describe('one FreeRADIUS writer per machine', () => {
  const ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ENV };
  });

  it('clears a lock left by a process that died, and refuses a live one after waiting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jbx-lock-'));
    const lock = join(dir, 'radius.lock');
    process.env.JOINTBOX_RADIUS_LOCK = lock;
    writeFileSync(lock, `999999 ${Date.now()}\n`); // no such process
    await expect(host.withHostLock(async () => 'ran')).resolves.toBe('ran');
    expect(existsSync(lock)).toBe(false);

    writeFileSync(lock, `${process.ppid} ${Date.now()}\n`); // alive
    await expect(host.withHostLock(async () => 'ran', 600)).rejects.toThrow(
      /still running/,
    );
    expect(readFileSync(lock, 'utf8')).toContain(String(process.ppid)); // not ours to remove
  });
});
