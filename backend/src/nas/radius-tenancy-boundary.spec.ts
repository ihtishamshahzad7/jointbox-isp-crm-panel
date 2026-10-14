import * as fs from 'fs';
import * as path from 'path';

/**
 * RATCHETS FOR THE RADIUS TENANCY POLICY (docs/RADIUS_TENANCY.md).
 *
 * 1. The switch (off / monitor / enforce) is changed only by the operator
 *    script on the server, never through the panel: no application code may
 *    touch radius_tenancy_setting, so no account — company or platform — can
 *    turn the policy off with an API call.
 * 2. Every place the panel talks to a router about a subscriber (RADIUS CoA /
 *    Disconnect, MikroTik API session or secret removal) asks the policy
 *    first. A new call site without the check fails here, naming file:line.
 */
const SRC = path.join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts'))
      out.push(p);
  }
  return out;
}

const files = sourceFiles(SRC).map((p) => ({
  rel: path.relative(SRC, p).split(path.sep).join('/'),
  lines: fs.readFileSync(p, 'utf8').split(/\r?\n/),
}));

describe('RADIUS tenancy ratchets', () => {
  it('no application code reads or writes the tenancy switch', () => {
    const hits = files.flatMap((f) =>
      f.lines
        .map((l, i) =>
          /radius_tenancy_setting|radiusTenancySetting/.test(l)
            ? `${f.rel}:${i + 1}`
            : null,
        )
        .filter(Boolean),
    );
    expect(hits).toEqual([]);
  });

  // Definitions, and calls that are about a ROUTER rather than one subscriber.
  // Each `within` names the enclosing method; anything else in the file is
  // still checked.
  const EXEMPT: Array<{ file: string; why: string; within?: RegExp }> = [
    { file: 'network/radius-coa.ts', why: 'sendCoa itself' },
    {
      file: 'nas/mikrotik-sync.service.ts',
      why: 'the router API client itself',
    },
    {
      file: 'mikrotik/mikrotik.service.ts',
      why: 'the router API client itself',
    },
    {
      file: 'network/coa.service.ts',
      within: /\btestCoa\(/,
      why: 'reachability probe: no subscriber',
    },
    {
      file: 'logs/logs.service.ts',
      within: /\bgetRouterLogsForNas\(/,
      why: "a router's own log, lines filtered to the caller's subscribers unless it owns the router",
    },
    {
      file: 'logs/router-logs.service.ts',
      within: /\b(collectFromNas|collectAll)\(/,
      why: 'platform collector, one router at a time',
    },
    {
      file: 'nas/nas.service.ts',
      within: /\bgetActiveSessions\(/,
      why: "a router's session list, filtered to the caller's subscribers",
    },
    {
      file: 'telemetry/live-traffic.service.ts',
      within: /\bpollOne\(/,
      why: 'router byte totals, no subscriber',
    },
    {
      file: 'subscribers/subscribers.service.ts',
      within: /\brouterPresence\(/,
      why: 'platform-wide online set, used only for rows the caller can already see',
    },
    {
      file: 'logs/network-logs.service.ts',
      within: /\breconcileOneRouter\(/,
      why: "platform sweep writing the router's own counters",
    },
    {
      file: 'subscribers/integrity.service.ts',
      within: /\breconcileSessionsWithRouter\(/,
      why: "router's live list; company runs close only their own subscribers' rows",
    },
    {
      file: 'subscribers/integrity.service.ts',
      within: /\bdisconnectUnknownRouterSessions\(/,
      why: 'platform sweep: sessions with no credential at all (no subscriber)',
    },
  ];
  // Every router-API / CoA call that can be about one subscriber.
  const CALL =
    /\bsendCoa\(|\.(disconnectPppoeUser|removePppSecret|removePppoeActive|setSecretRemoteAddress|clearSecretRemoteAddress|getActiveAddress|isSessionActive|getRouterLogs|getActivePppoeUsers|getPppoeActiveConnections|collectFromNas)\(/;
  const DEF =
    /^\s*(?:(?:public|private|protected)\s+)?(?:async\s+)?(sendCoa|disconnectPppoeUser|removePppSecret|removePppoeActive|setSecretRemoteAddress|clearSecretRemoteAddress|getActiveAddress|isSessionActive|getRouterLogs|getActivePppoeUsers|getPppoeActiveConnections|collectFromNas)\s*\(/;
  const METHOD =
    /^\s{2}(?:(?:public|private|protected)\s+)?(?:async\s+)?\w+\s*[<(]/;
  const GUARD = /\b(radiusTenancyAllows|tenancyAllows)\(|\bapiAllowed\b/;

  it('every CoA / router-API call about a subscriber is preceded by the tenancy check', () => {
    const unguarded: string[] = [];
    for (const f of files) {
      const exempt = EXEMPT.filter((e) => e.file === f.rel);
      if (exempt.some((e) => !e.within)) continue;
      f.lines.forEach((line, i) => {
        if (!CALL.test(line) || /^\s*(\*|\/\/)/.test(line)) return;
        if (DEF.test(line)) return; // a definition
        const start = f.lines
          .slice(0, i + 1)
          .map((l) => METHOD.test(l))
          .lastIndexOf(true);
        if (start >= 0 && exempt.some((e) => e.within!.test(f.lines[start])))
          return;
        const before = f.lines.slice(Math.max(0, i - 80), i + 1).join('\n');
        if (!GUARD.test(before)) unguarded.push(`${f.rel}:${i + 1}`);
      });
    }
    expect(unguarded).toEqual([]);
  });
});
