/**
 * Adds / removes the Jointbox tenancy policy hooks in a FreeRADIUS virtual
 * server file (sites-enabled/default and sites-enabled/inner-tunnel). Pure
 * text in, text out, so it can be tested without FreeRADIUS;
 * scripts/radius-tenancy.sh runs it from dist/.
 *
 *   authorize {   ... -sql   + jointbox_tenancy             (after the lookup)
 *   accounting {  ...        + jointbox_tenancy_accounting  (before the write)
 *                     -sql
 *
 * inner-tunnel gets the authorize hook too: with EAP-TTLS / PEAP the outer
 * identity is whatever the client chooses (a valid subscriber of the router's
 * company, say) and the identity whose password is checked is inside the
 * tunnel — without a hook there it is never compared with the router.
 *
 * Only the TOP-LEVEL authorize / accounting sections are touched (directly in
 * the file or inside `server <name> { }`), never a Post-Auth-Type block, an
 * `if`, or a commented-out line. Each hook is preceded by one marker comment,
 * and removing restores the file byte for byte.
 */

export const TENANCY_MARK =
  '# jointbox tenancy policy (backend/scripts/radius-tenancy.sh)';
export const AUTH_HOOK = 'jointbox_tenancy';
export const ACCT_HOOK = 'jointbox_tenancy_accounting';

export interface TenancyHooks {
  authorize: boolean;
  accounting: boolean;
}

export interface TenancyEdit {
  text: string;
  changed: boolean;
  hooks: TenancyHooks;
  /** Set when a section has no `sql` / `-sql` line to anchor the hook to. */
  problem?: string;
}

const SQL_LINE = /^-?sql\s*(#.*)?$/;

/** The code part of a line: comments dropped, quoted text blanked. */
function codeOf(line: string): string {
  let out = '';
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === '#') break;
    out += c;
  }
  return out;
}

/** Walk the file, reporting each line with the section stack it sits in. */
function walk(
  lines: string[],
  visit: (line: string, stack: string[], index: number) => void,
) {
  const stack: string[] = [];
  lines.forEach((line, index) => {
    visit(line, stack, index);
    const code = codeOf(line);
    const re = /([A-Za-z][\w-]*)?[^{}]*\{|\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      if (m[0] === '}') stack.pop();
      else stack.push(m[1] || '');
    }
  });
}

/** Is this stack exactly a top-level <name> section? */
function topLevel(stack: string[], name: string): boolean {
  return (
    (stack.length === 1 && stack[0] === name) ||
    (stack.length === 2 && stack[0] === 'server' && stack[1] === name)
  );
}

function split(text: string): { lines: string[]; eol: string } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { lines: text.split(eol), eol };
}

export function tenancyHooks(text: string): TenancyHooks {
  const hooks: TenancyHooks = { authorize: false, accounting: false };
  walk(split(text).lines, (line, stack) => {
    const s = line.trim();
    if (s === AUTH_HOOK && topLevel(stack, 'authorize')) hooks.authorize = true;
    if (s === ACCT_HOOK && topLevel(stack, 'accounting'))
      hooks.accounting = true;
  });
  return hooks;
}

export type TenancySection = 'authorize' | 'accounting';

/**
 * `sections`: which hooks this virtual server needs. The default server takes
 * both; inner-tunnel (EAP-TTLS / PEAP: the real identity inside the tunnel)
 * has no accounting section and takes the authorize hook only.
 */
export function addTenancyHooks(
  text: string,
  sections: TenancySection[] = ['authorize', 'accounting'],
): TenancyEdit {
  const { lines, eol } = split(text);
  const present = tenancyHooks(text);
  const want = new Set<TenancySection>(sections);
  const out: string[] = [];
  const added: TenancyHooks = { authorize: false, accounting: false };
  walk(lines, (line, stack) => {
    const s = line.trim();
    const indent = line.slice(0, line.length - line.trimStart().length);
    const isSql = SQL_LINE.test(s);
    if (
      isSql &&
      want.has('accounting') &&
      !present.accounting &&
      !added.accounting &&
      topLevel(stack, 'accounting')
    ) {
      out.push(indent + TENANCY_MARK, indent + ACCT_HOOK);
      added.accounting = true;
    }
    out.push(line);
    if (
      isSql &&
      want.has('authorize') &&
      !present.authorize &&
      !added.authorize &&
      topLevel(stack, 'authorize')
    ) {
      out.push(indent + TENANCY_MARK, indent + AUTH_HOOK);
      added.authorize = true;
    }
  });
  const hooks = {
    authorize: present.authorize || added.authorize,
    accounting: present.accounting || added.accounting,
  };
  const missing = sections.filter((k) => !hooks[k]);
  if (missing.length) {
    return {
      text,
      changed: false,
      hooks: present,
      problem: `no "sql" module line in the ${missing.join(' and ')} section${missing.length > 1 ? 's' : ''} to anchor the policy to`,
    };
  }
  const changed = added.authorize || added.accounting;
  return { text: changed ? out.join(eol) : text, changed, hooks };
}

export function removeTenancyHooks(text: string): TenancyEdit {
  const { lines, eol } = split(text);
  const out: string[] = [];
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (
      s === TENANCY_MARK &&
      i + 1 < lines.length &&
      [AUTH_HOOK, ACCT_HOOK].includes(lines[i + 1].trim())
    ) {
      i++;
      changed = true;
      continue;
    }
    if (s === AUTH_HOOK || s === ACCT_HOOK) {
      changed = true; // a hook someone added without the marker
      continue;
    }
    out.push(lines[i]);
  }
  const result = changed ? out.join(eol) : text;
  return { text: result, changed, hooks: tenancyHooks(result) };
}
