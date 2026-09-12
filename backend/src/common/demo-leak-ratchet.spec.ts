import * as fs from 'fs';
import * as path from 'path';

/**
 * THE RATCHET.
 *
 * Demo data reached ISP screens three separate times, and each fix held only
 * for the screen that was reported. The reason was structural, not careless:
 * the rule "an ISP-level account sees everything" had been written out
 * independently in several services as `isAdmin(...) -> {}` or `-> null`.
 * ScopeService was only one of its homes, so correcting ScopeService corrected
 * one screen and left the Users list, Insights, Reports, Analytics and the
 * business snapshot still reporting 10,016 subscribers and Rs 41m of invented
 * revenue.
 *
 * Whack-a-mole cannot end that, because the next person to add a service has no
 * way of knowing the rule exists in one place rather than six. This test makes
 * the rule's location enforceable: any NEW unrestricted admin short-circuit
 * fails here, with an explanation, before it can reach a screen.
 *
 * If you are reading this because the test just failed on code you wrote:
 * delegate to ScopeService (`subscriberWhere` / `userWhere` / `nasWhere` /
 * `ownedWhere` / `packageWhere` / `poolWhere`) instead of returning `{}` for an
 * admin. If your model genuinely has no demo dimension, add it to ALLOWED below
 * with a one-line reason.
 */
describe('demo leak ratchet', () => {
  const SRC = path.join(__dirname, '..');

  /**
   * Files permitted to short-circuit on isAdmin, each with the reason it is
   * safe. A reason is required: an allow-list without them becomes a list of
   * things nobody dares touch.
   */
  const ALLOWED: Record<string, string> = {
    'common/scope.service.ts':
      'The one home of the rule. Its admin branch returns the demo exclusion, not {}.',
    'ndm/ndm.service.ts':
      'Scopes NetworkDevice. The demo seeder creates Nas rows, never NetworkDevice, so there is no demo dimension to exclude.',
    'groups/groups.service.ts':
      'Returns an access-group overlay that the calling service layers on top of scope.nasWhere(), which already excludes demo routers.',
  };

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p, out);
      else if (entry.name.endsWith('.service.ts')) out.push(p);
    }
    return out;
  };

  /**
   * Matches an admin check that resolves to an unrestricted filter:
   *   if (this.scope.isAdmin(actor.role)) return {};
   *   const ids = isAdmin(...) ? null : ...
   *   const w = isAdmin(...) ? {} : ...
   */
  const SHORT_CIRCUIT = /isAdmin\([^)]*\)\s*\)?\s*(?:return\s*\{\}|\?\s*(?:null|\{\}))/;

  it('no service outside ScopeService grants an admin an unrestricted filter', () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (ALLOWED[rel]) continue;

      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (SHORT_CIRCUIT.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }

    if (offenders.length) {
      throw new Error(
        `These grant an ISP-level account an UNRESTRICTED filter, which lets the ` +
          `demo sandbox's synthetic subscribers, routers and resellers back onto real ` +
          `screens:\n\n  ${offenders.join('\n  ')}\n\n` +
          `Delegate to ScopeService (subscriberWhere / userWhere / nasWhere / ownedWhere / ` +
          `packageWhere / poolWhere) rather than returning {} for an admin. If the model has ` +
          `no demo dimension, add the file to ALLOWED in this spec with a reason.`,
      );
    }
  });

  /**
   * The allow-list is the weak point of a ratchet: entries outlive their
   * reasons, and a stale one is an unnoticed hole. Requiring the file to still
   * contain the pattern means an entry whose code was fixed shows up as dead
   * and gets removed, keeping the list honest about what is actually exempt.
   */
  it('every allow-list entry is still real and still needed', () => {
    for (const [rel, reason] of Object.entries(ALLOWED)) {
      const full = path.join(SRC, rel);
      expect(fs.existsSync(full)).toBe(true);
      expect(reason.length).toBeGreaterThan(30);
      if (rel === 'common/scope.service.ts') continue;
      const body = fs.readFileSync(full, 'utf8');
      expect(SHORT_CIRCUIT.test(body)).toBe(true);
    }
  });

  /**
   * The exemption ScopeService claims for itself has to be true. If its admin
   * branch ever returns a bare `{}` again, every screen in the app silently
   * goes back to showing sandbox data and no other test would notice.
   */
  it('ScopeService itself does not return a bare {} for an admin', () => {
    const body = fs.readFileSync(path.join(SRC, 'common/scope.service.ts'), 'utf8');
    const adminBranches = body
      .split('\n')
      .filter((l) => /isAdmin\(/.test(l) && /return\s*\{\}/.test(l));
    expect(adminBranches).toEqual([]);
  });
});
