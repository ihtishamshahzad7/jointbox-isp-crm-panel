import * as fs from 'fs';
import * as path from 'path';

/**
 * THE AUTHORIZATION MATRIX.
 *
 * A list of every HTTP route this API exposes, and — for each — whether the
 * handler ever gets hold of WHO is calling it.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * Every cross-tenant finding in both audits has had the same shape. Not a
 * broken `ScopeService`: `ScopeService` is correct. The bug is always a route
 * that never asks it. `bulkServiceSettings(ids)` takes a list of subscriber
 * ids and no actor, so it cannot check ownership even in principle — the
 * information is not in the function. Reviewing that one route fixes one
 * route; there are seven hundred.
 *
 * So the check is structural rather than per-endpoint: a handler that never
 * touches `req.user` (or a decorator that resolves to it) cannot be
 * tenant-aware, whatever its body does. That is a property a machine can read
 * off the source, on every commit, for every route, forever.
 *
 * ── What it does NOT prove ───────────────────────────────────────────────
 * Stated plainly so nobody reads more into a green test than is there:
 * passing an actor down is NECESSARY for tenant isolation, not SUFFICIENT.
 * A handler can take `req.user` and then ignore it. This catches the routes
 * that are structurally incapable of checking; proving the rest correct needs
 * the behavioural suite, which needs a database.
 *
 * Treat a passing matrix as "no route is missing the actor", never as
 * "tenant isolation is proven".
 */

export type Route = {
  file: string;
  controller: string;
  handler: string;
  method: string;
  routePath: string;
  /** The handler receives the caller's identity in some form. */
  actorAware: boolean;
  /** Route-level or class-level guard names found. */
  guards: string[];
  /** The class is decorated @Public, or the handler is. */
  isPublic: boolean;
};

const HTTP = ['Get', 'Post', 'Put', 'Patch', 'Delete'];

/**
 * The ways a handler can come by the caller's identity. `@Request() req` is
 * the common one; the codebase also uses `@CurrentUser()`, `@Req()`, and
 * reads `req.user` directly. Any of them means the identity is in scope.
 */
const ACTOR_SIGNALS = [
  /@Request\(\)/,
  /@Req\(\)/,
  /@CurrentUser\(/,
  /@User\(\)/,
  /req\.user/,
  /request\.user/,
];

function listControllers(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.controller.ts')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * A deliberately small parser rather than the TypeScript compiler API.
 *
 * The compiler would be more correct, and it would also be a new dependency
 * plus a build step in a test that has to stay fast enough to run on every
 * commit. What this needs to find — decorators and a parameter list — is
 * unambiguous in source text. Where it cannot be sure, it errs toward
 * reporting a route as NOT actor-aware, so the failure mode is a false
 * finding somebody investigates, never a real one waved through.
 */
export function parseController(file: string, src: string): Route[] {
  const controller = (src.match(/export class (\w+)/) || [, path.basename(file)])[1];
  const classDecorators = src.slice(0, src.indexOf('export class'));
  const classGuards = [...classDecorators.matchAll(/@UseGuards\(([^)]*)\)/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim()))
    .filter(Boolean);
  const base = (src.match(/@Controller\(\s*['"]([^'"]*)['"]/) || [, ''])[1];
  const classPublic = /@Public\(\)/.test(classDecorators);

  const routes: Route[] = [];
  const verb = new RegExp(`@(${HTTP.join('|')})\\(`, 'g');
  let m: RegExpExecArray | null;

  while ((m = verb.exec(src))) {
    const method = m[1].toUpperCase();

    // The route path argument, if any: @Get(), @Get('x'), @Get(':id')
    const argEnd = src.indexOf(')', m.index);
    const arg = src.slice(m.index + m[0].length, argEnd).trim();
    const routePath = (arg.match(/^['"]([^'"]*)['"]/) || [, ''])[1];

    // Decorators attached to THIS handler sit between the previous handler's
    // closing and this verb; walk back to the start of the decorator block.
    const before = src.slice(0, m.index);
    const blockStart = Math.max(
      before.lastIndexOf('\n\n'),
      before.lastIndexOf('}\n'),
      before.lastIndexOf('export class'),
    );
    const decorators = src.slice(blockStart, m.index);

    // The handler signature: from the verb to the opening brace of the body.
    // Decorators may also sit BETWEEN the verb and the method name —
    //   @Get('profile')
    //   @UseGuards(JwtAuthGuard)
    //   profile(@Request() req) {...}
    // — which is the more common Nest ordering. Missing this was worth fixing
    // rather than working around: the first run of this parser reported 42
    // unguarded routes, most of which were guarded on the line below the one
    // it was reading. A matrix that cries wolf gets ignored, and an ignored
    // matrix is worse than none.
    const after = src.slice(argEnd);

    /**
     * Where the handler BODY begins. Naively this is the first `{` after the
     * verb — but a typed parameter list can contain braces of its own
     * (`@Body() body: { ids: number[] }, @Req() req: any`), and landing inside
     * a type annotation cuts the signature off before a trailing `@Req()` and
     * hides the entire body from the actor probe. A handler that genuinely
     * receives `req.user` was then reported as NOT actor-aware.
     *
     * That matters more here than in the normal false-finding case. A parser
     * that cries wolf about a route which is actually fixed is not a harmless
     * extra entry on a list: the list is the remediation queue, and every item
     * on it is a small lie that trains the reader to ignore it. So the source
     * is parsed as far as the handler's parameter list — the first
     * identifier-followed-by-`(` that is not part of a decorator — balanced to
     * its closing paren, and the body is the first `{` after that.
     */
    const bodyStart = locateBodyStart(after);
    const signature = after.slice(0, bodyStart < 0 ? 400 : bodyStart);
    // Strip the trailing decorators to find the real handler name.
    const nameRegion = signature.replace(/@\w+\s*\([\s\S]*?\)/g, ' ');
    const handler = (nameRegion.match(/(?:async\s+)?(\w+)\s*\(/) || [, '?'])[1];

    // The body, bounded by brace depth, so `req.user` inside it counts.
    const body = extractBody(after.slice(bodyStart));

    const guards = [
      ...classGuards,
      ...[...(decorators + signature).matchAll(/@UseGuards\(([^)]*)\)/g)].flatMap((g) =>
        g[1].split(',').map((s) => s.trim()),
      ),
    ].filter(Boolean);

    const probe = signature + body;
    routes.push({
      file,
      controller,
      handler,
      method,
      routePath: `/${[base, routePath].filter(Boolean).join('/')}`.replace(/\/+/g, '/'),
      actorAware: ACTOR_SIGNALS.some((r) => r.test(probe)),
      guards: [...new Set(guards)],
      isPublic: classPublic || /@Public\(\)/.test(decorators + signature),
    });
  }
  return routes;
}

/** Brace-matched body, ignoring braces inside strings and template literals. */
function extractBody(s: string): string {
  if (s[0] !== '{') return s.slice(0, 600);
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(0, i + 1);
  }
  return s;
}

/**
 * The position of a handler body's opening brace in the text that follows a
 * route verb, or -1 when no parameter list can be found.
 *
 * The handler's parameter list is the first identifier-followed-by-`(`
 * that is NOT part of a decorator: decorator names are preceded by `@`, and
 * decorator arguments (quoted strings, identifiers, comma lists) do not look
 * like a parameter list either — so the first match is the method's own
 * opening paren. That list is paren-balanced, taking quoted strings into
 * account, and the return value is the first `{` after it closes.
 *
 * Falls back to the naive first-`{` search when nothing matches, so an
 * unparseable handler still errs towards NOT actor-aware instead of crashing
 * the matrix.
 */
function locateBodyStart(after: string): number {
  const m = after.match(/(?<![@\w])(?:async\s+)?\w+\s*\(/);
  if (!m) return after.indexOf('{');
  const paren = after.indexOf(m[0]) + m[0].lastIndexOf('(');
  if (paren < 0) return after.indexOf('{');
  let depth = 0;
  let quote: string | null = null;
  for (let i = paren; i < after.length; i++) {
    const c = after[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) {
      const rest = after.slice(i + 1);
      const open = rest.indexOf('{');
      return open < 0 ? -1 : i + 1 + open;
    }
  }
  return after.indexOf('{');
}

export function buildMatrix(srcRoot = path.join(__dirname, '..')): Route[] {
  return listControllers(srcRoot).flatMap((f) =>
    parseController(path.relative(srcRoot, f), fs.readFileSync(f, 'utf8')),
  );
}
