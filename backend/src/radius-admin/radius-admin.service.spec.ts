import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  symlinkSync,
  lstatSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RadiusAdminService } from './radius-admin.service';
import { VAULT_INCLUDE_LINE } from '../nas/radius-clients-render';
import { addTenancyHooks } from '../nas/radius-tenancy-site';

/**
 * The platform's FreeRADIUS file editor runs as root on the RADIUS server.
 * These pin what it must never do: show or overwrite router secrets, leave a
 * configuration FreeRADIUS rejects, or drop the router list include.
 */
describe('FreeRADIUS admin screen', () => {
  const ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ENV };
  });

  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'jbx-radadm-'));
    for (const d of [
      'clients.d',
      'certs',
      'mods-available',
      'mods-enabled',
      'policy.d',
      'sites-available',
    ])
      mkdirSync(join(root, d));
    writeFileSync(
      join(root, 'policy.d', 'jointbox-tenancy'),
      'jointbox_tenancy {\n\tnoop\n}\n',
    );
    writeFileSync(
      join(root, 'sites-available', 'default'),
      addTenancyHooks(
        'server default {\nauthorize {\n\t-sql\n\tpap\n}\naccounting {\n\t-sql\n}\n}\n',
      ).text,
    );
    writeFileSync(join(root, 'radiusd.conf'), 'user = freerad\n');
    writeFileSync(
      join(root, 'clients.conf'),
      `client localhost {\n\tipaddr = 127.0.0.1\n\tsecret = 'local-only'\n}\n${VAULT_INCLUDE_LINE}\n`,
    );
    writeFileSync(
      join(root, 'clients.d', 'jointbox-nas.conf'),
      "client jointbox-nas-1 {\n\tsecret = 'router'\n}\n",
    );
    writeFileSync(join(root, 'certs', 'server.key'), 'PRIVATE');
    writeFileSync(join(root, 'mods-available', 'ldap'), 'ldap {}\n');
    process.env.FREERADIUS_DIR = root;
    process.env.FREERADIUS_CHECK_CMD = 'true';
    process.env.FREERADIUS_RESTART_CMD = 'true';
    process.env.FREERADIUS_STATUS_CMD = 'true';
    process.env.JOINTBOX_RADIUS_LOCK = join(root, 'radius.lock');
    process.env.JOINTBOX_RADIUS_BACKUP_DIR = join(
      root,
      '..',
      `${root.split('/').pop()}-backups`,
    );
    const vault: any = {
      mode: () => 'file',
      refreshMode: () => 'file',
      apply: jest.fn().mockResolvedValue({ ok: true }),
    };
    return { root, svc: new RadiusAdminService({} as any, vault), vault };
  }

  it('never opens the generated router list or private keys', async () => {
    const { svc } = setup();
    await expect(svc.readFile('clients.d/jointbox-nas.conf')).rejects.toThrow(
      /NAS page/,
    );
    await expect(
      svc.writeFile('clients.d/jointbox-nas.conf', 'x'),
    ).rejects.toThrow(/NAS page/);
    await expect(svc.readFile('certs/server.key')).rejects.toThrow(
      /private keys/,
    );
    await expect(svc.readFile('../../etc/passwd')).rejects.toThrow(/outside/);
  });

  it('follows a symlink only within the config folder', async () => {
    const { root, svc } = setup();
    symlinkSync('/etc/hostname', join(root, 'mods-enabled', 'escape'));
    await expect(svc.readFile('mods-enabled/escape')).rejects.toThrow(
      /outside/,
    );
  });

  it('shows secrets as <hidden> and keeps them when the file is saved', async () => {
    const { root, svc } = setup();
    const r = await svc.readFile('clients.conf');
    expect(r.content).not.toContain('local-only');
    const edited = r.content.replace('127.0.0.1', '127.0.0.1 # edited');
    const w: any = await svc.writeFile('clients.conf', edited);
    expect(w.ok).toBe(true);
    const now = readFileSync(join(root, 'clients.conf'), 'utf8');
    expect(now).toContain("secret = 'local-only'");
    expect(now).toContain('# edited');
    // the backup is outside the config folder (a copy inside sites-enabled/
    // or mods-enabled/ would itself be loaded by FreeRADIUS)
    expect(readdirSync(root).some((f) => /bak/.test(f))).toBe(false);
    expect(existsSync(process.env.JOINTBOX_RADIUS_BACKUP_DIR!)).toBe(true);
  });

  it('refuses to drop the router list include from clients.conf', async () => {
    const { root, svc } = setup();
    const before = readFileSync(join(root, 'clients.conf'), 'utf8');
    const r = await svc.readFile('clients.conf');
    const w: any = await svc.writeFile(
      'clients.conf',
      r.content.replace(VAULT_INCLUDE_LINE, ''),
    );
    expect(w.ok).toBe(false);
    expect(w.message).toMatch(/must keep the line/);
    expect(readFileSync(join(root, 'clients.conf'), 'utf8')).toBe(before);
  });

  it('never edits the tenancy policy file and never drops its hooks', async () => {
    const { root, svc } = setup();
    const policy = await svc.readFile('policy.d/jointbox-tenancy');
    const w1: any = await svc.writeFile(
      'policy.d/jointbox-tenancy',
      policy.content.replace('noop', 'ok'),
    );
    expect(w1.ok).toBe(false);
    expect(w1.message).toMatch(/radius-tenancy\.sh/);
    expect(
      readFileSync(join(root, 'policy.d', 'jointbox-tenancy'), 'utf8'),
    ).toContain('noop');

    const before = readFileSync(
      join(root, 'sites-available', 'default'),
      'utf8',
    );
    const site = await svc.readFile('sites-available/default');
    const w2: any = await svc.writeFile(
      'sites-available/default',
      site.content.replace(/\tjointbox_tenancy\n/, ''),
    );
    expect(w2.ok).toBe(false);
    expect(w2.message).toMatch(/tenancy hooks/);
    expect(readFileSync(join(root, 'sites-available', 'default'), 'utf8')).toBe(
      before,
    );

    // other edits of the same file are still possible
    const w3: any = await svc.writeFile(
      'sites-available/default',
      site.content.replace('\tpap', '\tpap\n\t# note'),
    );
    expect(w3.ok).toBe(true);
  });

  it('puts the previous version back when FreeRADIUS rejects the edit', async () => {
    const { root, svc } = setup();
    process.env.FREERADIUS_CHECK_CMD =
      'echo "clients.conf[9]: Parse error" >&2; false';
    const before = readFileSync(join(root, 'clients.conf'), 'utf8');
    const r = await svc.readFile('clients.conf');
    const w: any = await svc.writeFile(
      'clients.conf',
      `${r.content}client broken {\n`,
    );
    expect(w).toMatchObject({ ok: false, restored: true });
    expect(w.message).toMatch(/clients\.conf\[9\]/);
    expect(readFileSync(join(root, 'clients.conf'), 'utf8')).toBe(before);
  });

  it('undoes a module switch FreeRADIUS would not start with', async () => {
    const { root, svc } = setup();
    process.env.FREERADIUS_CHECK_CMD = 'false';
    const r: any = await svc.toggleModule('ldap', true);
    expect(r).toMatchObject({
      configOk: false,
      reverted: true,
      enabled: false,
    });
    expect(() => lstatSync(join(root, 'mods-enabled', 'ldap'))).toThrow();
  });
});
