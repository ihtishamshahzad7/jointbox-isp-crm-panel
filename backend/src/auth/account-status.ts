import { PrismaService } from '../prisma/prisma.service';

/**
 * IS THIS ACCOUNT ALLOWED TO ACT RIGHT NOW?
 *
 * A JWT is a statement made when the user logged in. It says nothing about
 * what has happened since — and two things that happen since must take effect
 * immediately, not when the 7-day token happens to expire:
 *
 *   • the account was SUSPENDED (isActive=false) — a company that stopped
 *     paying, a dealer under investigation, a staff member who has left;
 *   • the account must CHANGE ITS PASSWORD before doing anything else.
 *
 * Until this existed, nothing in the auth path read isActive at all: login did
 * not check it, refresh did not check it, the strategy did not check it. Every
 * "deactivate" button in the product changed a column that no request ever
 * consulted, so a suspended account kept full access.
 *
 * Cached per user for a short window so this is not a database round-trip on
 * every request. The cost of the window is that a suspension takes up to TTL
 * to bite; the writers below call invalidate() so the change is immediate in
 * this process, and the TTL bounds it everywhere else.
 */
const TTL_MS = 30_000;

/** `role` is the account's CURRENT role — a role change applies within the cache TTL, not at token expiry. */
type Status = {
  active: boolean;
  mustChangePassword: boolean;
  role?: string;
  isDemo?: boolean;
  tokenVersion?: number;
  /** The company's plan with the platform has ended (company_plan.expiresAt). */
  planEnded?: boolean;
  at: number;
};

/** Shown when a company's time on the platform has run out. */
export const PLAN_ENDED_MESSAGE =
  "Your company's access to this panel has ended. Contact the platform owner to renew it.";
const cache = new Map<number, Status>();

export async function accountStatus(
  prisma: PrismaService,
  userId: number,
): Promise<Status | null> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;

  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { isActive: true, mustChangePassword: true, role: true, isDemo: true, tokenVersion: true },
  });
  if (!u) {
    cache.delete(userId);
    return null;
  }

  /**
   * ACTIVE MEANS THIS ACCOUNT *AND EVERY ACCOUNT ABOVE IT*.
   *
   * Suspending an ISP company is a decision about the whole business. If it
   * stopped only the owner's login, the company's franchises and dealers would
   * carry on selling under a suspended parent — which is the opposite of what
   * the person pressing Suspend meant. The same holds one level down: a
   * suspended franchise's dealers stop with it.
   *
   * This matches the direction everything else in the tree already flows:
   * visibility and sharing are inherited downward, so is suspension.
   */
  let chainActive = u.isActive !== false;
  if (chainActive) {
    const rows = await prisma.$queryRaw<Array<{ ok: boolean | null }>>`
      WITH RECURSIVE up AS (
        SELECT id, "parentId", "isActive" FROM "User" WHERE id = ${userId}
        UNION ALL
        SELECT p.id, p."parentId", p."isActive" FROM "User" p JOIN up ON p.id = up."parentId"
        -- the platform account is above every company but owns none of them:
        -- its own status never locks a company out
        WHERE p.role <> 'SUPER_ADMIN'
      )
      SELECT bool_and("isActive") AS ok FROM up`;
    chainActive = rows[0]?.ok !== false;
  }

  /**
   * THE COMPANY'S PLAN END DATE, set by the platform account (Companies →
   * Plan & limits). Past it, the company and everyone under it stop, just
   * like a suspension, but with a message that says why. A separate query
   * on purpose: on a server where the table does not exist yet the answer
   * is simply "not ended" — never a lock-out.
   */
  let planEnded = false;
  if (chainActive && u.role !== 'SUPER_ADMIN') {
    try {
      const rows = await prisma.$queryRaw<Array<{ ended: boolean | null }>>`
        WITH RECURSIVE up AS (
          SELECT id, "parentId", 0 AS depth FROM "User" WHERE id = ${userId}
          UNION ALL
          SELECT p.id, p."parentId", up.depth + 1 FROM "User" p JOIN up ON p.id = up."parentId"
          WHERE up.depth < 20 AND p.role <> 'SUPER_ADMIN'
        )
        SELECT EXISTS (
          SELECT 1 FROM company_plan cp
          WHERE cp."companyId" IN (SELECT id FROM up)
            AND cp."expiresAt" IS NOT NULL AND cp."expiresAt" < NOW()
        ) AS ended`;
      planEnded = rows[0]?.ended === true;
    } catch {
      planEnded = false;
    }
  }

  const s: Status = {
    active: chainActive,
    planEnded,
    mustChangePassword: u.mustChangePassword === true,
    role: (u as any).role ? String((u as any).role) : undefined,
    isDemo: (u as any).isDemo === true,
    tokenVersion: Number((u as any).tokenVersion ?? 0),
    at: Date.now(),
  };
  cache.set(userId, s);
  // Bounded: an evicted entry costs one query, an unbounded map costs memory forever.
  if (cache.size > 5000) cache.delete(cache.keys().next().value as number);
  return s;
}

/** Call after any write to isActive or mustChangePassword. */
export function invalidateAccountStatus(userId: number): void {
  cache.delete(userId);
}

/**
 * Suspending an account changes the answer for its entire downline, and the
 * cache is keyed per user — so a toggle drops everything. The cache is small
 * and rebuilds on demand; a stale "active" for a suspended company's dealer is
 * the failure that matters.
 */
export function invalidateAllAccountStatus(): void {
  cache.clear();
}

/**
 * Routes a user who must change their password can still reach: the change
 * itself, the profile that tells the UI why it is being redirected, and the
 * way out. Matched on the path's tail so a proxy prefix (/api) does not matter.
 */
export const PASSWORD_CHANGE_ALLOWED =
  /\/(auth\/(change-password|profile|logout)|profile)\/?$/;

/** The published default. An owner account still using it is forced to change. */
export const PUBLISHED_DEFAULT_PASSWORD = 'admin123';
