import {
  ACCT_HOOK,
  AUTH_HOOK,
  TENANCY_MARK,
  addTenancyHooks,
  removeTenancyHooks,
  tenancyHooks,
} from './radius-tenancy-site';

/**
 * The tenancy hooks must land in exactly two places of the FreeRADIUS site:
 * after the radcheck lookup in authorize, before the write in accounting —
 * never in a Post-Auth-Type block, an `if`, or on a commented-out line.
 */
const SITE = [
  '######################################################################',
  '#  sql   <- a comment that mentions sql',
  'server default {',
  'listen {',
  '\ttype = auth',
  '}',
  'authorize {',
  '\tfilter_username',
  '\tchap',
  '\tmschap',
  '\t#  sql',
  '\tif (&User-Name == "x{y}") {',
  '\t\tsql',
  '\t}',
  '\t-sql',
  '\texpiration',
  '\tpap',
  '}',
  'authenticate {',
  '\tAuth-Type PAP {',
  '\t\tpap',
  '\t}',
  '}',
  'accounting {',
  '\tdetail',
  '\tunix',
  '\t-sql',
  '\texec',
  '}',
  'post-auth {',
  '\t-sql',
  '\tPost-Auth-Type REJECT {',
  '\t\t-sql',
  '\t}',
  '}',
  '}',
  '',
].join('\n');

describe('FreeRADIUS tenancy hooks', () => {
  it('adds one hook after the authorize lookup and one before the accounting write', () => {
    const r = addTenancyHooks(SITE);
    expect(r.problem).toBeUndefined();
    expect(r.changed).toBe(true);
    const lines = r.text.split('\n');
    const auth = lines.indexOf('\t' + AUTH_HOOK);
    const acct = lines.indexOf('\t' + ACCT_HOOK);
    expect(lines[auth - 1]).toBe('\t' + TENANCY_MARK);
    expect(lines[auth - 2]).toBe('\t-sql'); // after the lookup, not after the `if` copy
    expect(lines[auth + 1]).toBe('\texpiration');
    expect(lines[acct + 1]).toBe('\t-sql'); // before the write
    expect(lines[acct - 2]).toBe('\tunix');
    expect(lines.filter((l) => l.trim() === AUTH_HOOK)).toHaveLength(1);
    expect(lines.filter((l) => l.trim() === ACCT_HOOK)).toHaveLength(1);
    // post-auth untouched
    expect(r.text.slice(r.text.indexOf('post-auth {'))).toBe(
      SITE.slice(SITE.indexOf('post-auth {')),
    );
    expect(tenancyHooks(r.text)).toEqual({ authorize: true, accounting: true });
  });

  it('is idempotent and removes back to the original byte for byte', () => {
    const once = addTenancyHooks(SITE).text;
    const twice = addTenancyHooks(once);
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once);
    const removed = removeTenancyHooks(once);
    expect(removed.changed).toBe(true);
    expect(removed.text).toBe(SITE);
    expect(removeTenancyHooks(SITE).changed).toBe(false);
  });

  it('keeps CRLF line endings', () => {
    const crlf = SITE.replace(/\n/g, '\r\n');
    const r = addTenancyHooks(crlf);
    expect(r.text.includes('\r\n\t' + AUTH_HOOK + '\r\n')).toBe(true);
    expect(r.text.replace(/\r\n/g, '').includes('\n')).toBe(false);
    expect(removeTenancyHooks(r.text).text).toBe(crlf);
  });

  it('works on a site without the server { } wrapper', () => {
    const bare = SITE.replace('server default {\n', '').replace(/\}\n$/, '\n');
    expect(addTenancyHooks(bare).hooks).toEqual({
      authorize: true,
      accounting: true,
    });
  });

  it('adds only the missing hook when one is already there', () => {
    const once = addTenancyHooks(SITE).text;
    const onlyAcct = once.replace(`\t${TENANCY_MARK}\n\t${AUTH_HOOK}\n`, '');
    expect(tenancyHooks(onlyAcct)).toEqual({
      authorize: false,
      accounting: true,
    });
    const r = addTenancyHooks(onlyAcct);
    expect(r.text).toBe(once);
  });

  it('refuses (changes nothing) when a section has no sql line to anchor to', () => {
    const noSql = SITE.replace('\t-sql\n\texpiration', '\texpiration');
    const r = addTenancyHooks(noSql);
    expect(r.changed).toBe(false);
    expect(r.text).toBe(noSql);
    expect(r.problem).toMatch(/authorize section/);
  });

  it('inner-tunnel takes the authorize hook only (it has no accounting section)', () => {
    const inner = [
      'server inner-tunnel {',
      'authorize {',
      '\teap {',
      '\t\tok = return',
      '\t}',
      '\t-sql',
      '\tpap',
      '}',
      'post-auth {',
      '\t-sql',
      '}',
      '}',
      '',
    ].join('\n');
    expect(addTenancyHooks(inner).problem).toMatch(/accounting section/);
    const r = addTenancyHooks(inner, ['authorize']);
    expect(r.problem).toBeUndefined();
    expect(r.hooks).toEqual({ authorize: true, accounting: false });
    expect(r.text).toContain(
      `\t-sql\n\t${TENANCY_MARK}\n\t${AUTH_HOOK}\n\tpap`,
    );
    expect(removeTenancyHooks(r.text).text).toBe(inner);
  });

  it('does not treat a hook inside a nested block as installed', () => {
    const nested = SITE.replace(
      '\t\tsql\n\t}',
      `\t\tsql\n\t\t${AUTH_HOOK}\n\t}`,
    );
    expect(tenancyHooks(nested).authorize).toBe(false);
  });
});
