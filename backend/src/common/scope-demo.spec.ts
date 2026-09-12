import { ScopeService } from './scope.service';

/**
 * DEMO DATA MUST NOT COUNT AS BUSINESS DATA.
 *
 * The sandbox seeds 10,000 synthetic subscribers and 500 invented routers under
 * a demo-flagged user. Reseller scoping already kept those away from other
 * tenants, but SUPER_ADMIN is scoped by nothing, so the platform owner's own
 * dashboard read "Total subscribers 10,016 / Signups today 10,000" — sixteen
 * real customers buried in ten thousand fabricated ones, with no way to tell
 * from the screen which was which.
 *
 * These tests pin the three things that have to stay true at once:
 *   1. an ISP-level account never counts demo-owned rows,
 *   2. the demo account still sees its own rich environment,
 *   3. ownerless rows — unbilled service — are never hidden as a side effect.
 */
describe('scope: demo isolation', () => {
  const prisma: any = {
    $queryRaw: jest.fn(async () => [{ id: 7 }, { id: 8 }]),
    user: { findUnique: jest.fn(async () => ({ parentId: null })) },
  };
  const scope = new ScopeService(prisma);

  const ORIGINAL = process.env.DEMO_VISIBLE_TO_ADMIN;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DEMO_VISIBLE_TO_ADMIN;
    else process.env.DEMO_VISIBLE_TO_ADMIN = ORIGINAL;
  });

  const admin = { sub: 1, role: 'SUPER_ADMIN' };
  const demoReseller = { sub: 7, role: 'RESELLER' };

  // ── 1. the platform owner ────────────────────────────────────────────────
  it('THE FIX: an ISP-level account no longer counts demo-owned subscribers', async () => {
    const where = await scope.subscriberWhere(admin);
    // Not the empty object it used to be — an empty filter is what let 10,000
    // synthetic rows into the owner's totals.
    expect(where).not.toEqual({});
    expect(where.OR).toEqual([
      { userId: null },
      { user: { is: { isDemo: false } } },
    ]);
  });

  it('excludes demo-owned routers from the ISP NAS count too', async () => {
    const where = await scope.nasWhere(admin);
    expect(where.OR).toEqual([
      { ownerId: null },
      { owner: { is: { isDemo: false } } },
    ]);
  });

  /**
   * The clause must keep ownerless rows.
   *
   * `userId` is nullable, and a subscriber with no owner is not a curiosity —
   * it is service being given away that appears in nobody's books. Writing the
   * filter as "owner is not a demo" alone would have dropped every one of them
   * from the admin's view, turning a data-hygiene fix into a revenue leak that
   * hides itself. The OR's first branch is that guarantee, so assert on it
   * directly rather than trusting the shape above to keep it.
   */
  it('keeps ownerless rows visible — they are unbilled service, not noise', async () => {
    const where = await scope.subscriberWhere(admin);
    expect(where.OR[0]).toEqual({ userId: null });

    // Evaluate the clause the way Postgres would, over the three row kinds.
    const rows = [
      { label: 'real', userId: 5, owner: { isDemo: false } },
      { label: 'demo', userId: 6, owner: { isDemo: true } },
      { label: 'ownerless', userId: null, owner: null },
    ];
    const visible = rows
      .filter((r) => r.userId === null || r.owner?.isDemo === false)
      .map((r) => r.label);
    expect(visible).toEqual(['real', 'ownerless']);
  });

  /**
   * The 143 synthetic franchises, dealers and sub-dealers filled the ISP's
   * Users & Staff list (144 accounts, four of them real), its wallet list, and
   * its reseller counts. `isDemo` is non-nullable with a default, so unlike the
   * owner relations there is no null case to preserve here.
   */
  it('hides the demo reseller tree from ISP account lists and wallets', async () => {
    expect(await scope.userWhere(admin)).toEqual({ isDemo: false });
  });

  it.each([
    ['ownedWhere', 'areas'],
    ['packageWhere', 'packages'],
    ['poolWhere', 'IP pools'],
  ])('%s excludes demo-owned %s from ISP views', async (method) => {
    const where = await (scope as any)[method](admin);
    expect(where.OR).toEqual([
      { ownerId: null },
      { owner: { is: { isDemo: false } } },
    ]);
  });

  /**
   * analytics builds its scope as interpolated SQL, so it cannot use the
   * Prisma objects above. The fragments live here anyway — four services each
   * writing their own version of this rule is what caused the leak.
   */
  describe('raw-SQL fragments, for services that hand-write queries', () => {
    it('excludes demo subscribers while keeping ownerless ones', () => {
      const sql = scope.demoExclusionSql('s');
      expect(sql).toMatch(/s\."userId" IS NULL/);   // unbilled service stays visible
      expect(sql).toMatch(/_du\."isDemo" = true/);
      expect(sql.trim().startsWith('AND')).toBe(true); // appends to an existing WHERE
    });

    it('excludes demo users from a user-keyed query', () => {
      expect(scope.demoUserExclusionSql('u')).toMatch(/u\."isDemo" = false/);
    });

    it('both fragments empty out when the override is set', () => {
      process.env.DEMO_VISIBLE_TO_ADMIN = '1';
      expect(scope.demoExclusionSql('s')).toBe('');
      expect(scope.demoUserExclusionSql('u')).toBe('');
    });

    /**
     * The alias is supplied by calling code, never by a request — but an empty
     * fragment spliced into `WHERE 1=1 ${own}` must still leave valid SQL, and
     * a non-empty one must not begin a new clause of its own.
     */
    it('never emits a fragment that could break the surrounding query', () => {
      delete process.env.DEMO_VISIBLE_TO_ADMIN;
      for (const alias of ['s', 'sub', 'x1']) {
        const sql = scope.demoExclusionSql(alias);
        expect(sql).not.toMatch(/;/);
        // It must ATTACH to the caller's WHERE, never open a clause of its own.
        // The subquery has its own WHERE, which is fine — what matters is that
        // the fragment starts with AND and that every WHERE sits inside the
        // parenthesised EXISTS.
        expect(sql.trim().startsWith('AND ')).toBe(true);
        expect(sql.trim()).not.toMatch(/^WHERE/);
        const beforeSubquery = sql.slice(0, sql.indexOf('SELECT 1'));
        expect(beforeSubquery).not.toMatch(/\bWHERE\b/);
        // Balanced parentheses, or the query fails to parse at runtime.
        const open = (sql.match(/\(/g) || []).length;
        const close = (sql.match(/\)/g) || []).length;
        expect(open).toBe(close);
      }
    });
  });

  // ── 2. the demo account itself ───────────────────────────────────────────
  /**
   * The whole point of the sandbox is that a visitor sees a busy, realistic
   * ISP. If the exclusion reached the demo account it would be shown an empty
   * panel — the fix would have destroyed the feature it was protecting.
   */
  it('the demo account still sees its own data (subtree scoping, untouched)', async () => {
    const where = await scope.subscriberWhere(demoReseller);
    expect(where).toEqual({ userId: { in: [7, 8] } });
    expect(where.OR).toBeUndefined();
  });

  // ── 3. the escape hatch ──────────────────────────────────────────────────
  /**
   * A guard with no way out is how the connection-policy check took production
   * down: it named a remedy it did not implement, and an operator following the
   * advice got the same refusal. Anything that hides data from an administrator
   * gets a documented switch.
   */
  it('DEMO_VISIBLE_TO_ADMIN=1 restores the old behaviour', async () => {
    process.env.DEMO_VISIBLE_TO_ADMIN = '1';
    expect(await scope.subscriberWhere(admin)).toEqual({});
    expect(await scope.nasWhere(admin)).toEqual({});
  });

  /**
   * Only the documented value opens it. `'true'` is included deliberately: it
   * is the value an operator is most likely to reach for by habit, and it must
   * NOT work — a switch that half-works is worse than one that does not, since
   * the operator believes demo data is visible and reads the numbers as if it
   * were. Fail closed, so the totals on screen are always the safe ones.
   */
  it.each(['0', 'false', 'no', '', 'true', 'yes', '1 '])(
    'stays closed for DEMO_VISIBLE_TO_ADMIN=%p',
    async (v) => {
      process.env.DEMO_VISIBLE_TO_ADMIN = v;
      expect(await scope.subscriberWhere(admin)).not.toEqual({});
    },
  );

  // ── composition ──────────────────────────────────────────────────────────
  /**
   * computeOverview() wraps every count as `{ AND: [clause, scopeWhere] }` only
   * when scopeWhere is non-empty. Before this change SUPER_ADMIN returned `{}`
   * and that branch never ran for them, so this is the first time an admin's
   * counts are composed at all — worth asserting the shape is composable.
   */
  it('the fragment composes under AND without swallowing the other clause', async () => {
    const scopeWhere = await scope.subscriberWhere(admin);
    const withScope = (w: any) =>
      Object.keys(scopeWhere).length ? { AND: [w, scopeWhere] } : w;
    const composed = withScope({ status: 'ACTIVE' });
    expect(composed.AND[0]).toEqual({ status: 'ACTIVE' });
    expect(composed.AND[1].OR).toHaveLength(2);
  });
});
