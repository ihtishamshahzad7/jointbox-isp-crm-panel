/**
 * EVERY INSTALLATION HAS A PLATFORM ACCOUNT THAT RUNS NO BUSINESS.
 *
 *   SUPER_ADMIN  — companies, licence, server, backups, defaults
 *   ADMIN        — one ISP company: its subscribers, routers, billing
 *
 * The platform account is refused every business route
 * (platform-boundary.interceptor.ts). Older installs ran their business
 * straight from the top account, so run once at boot, idempotently:
 *
 *  • An active SUPER_ADMIN that owns subscribers, routers or a downline is
 *    SPLIT: it becomes its company's ADMIN — same login, same data, nothing
 *    moves — and a new platform login is created above it, with the SAME
 *    password hash (so no new secret exists) and a forced password change.
 *    Other companies under it are moved up to the new platform account.
 *  • No SUPER_ADMIN at all (installs that ran the owner as ADMIN): the oldest
 *    top-level ADMIN keeps its business; a platform login is created above
 *    it the same way. An empty top-level ADMIN is simply promoted instead.
 *  • Business rows with no owner (only ever visible to the old top account)
 *    are given to the company, so nothing disappears from its screens.
 */

const DOWNLINE_ROLES = [
  'RESELLER',
  'SUB_RESELLER',
  'RETAILER',
  'SALES',
  'AUDITOR',
];

type Acct = {
  id: number;
  email: string;
  password: string | null;
  name?: string | null;
};

export type PlatformSplitResult =
  | { action: 'none' }
  | { action: 'promoted'; platformEmail: string }
  | { action: 'split'; platformEmail: string; companyEmail: string };

/** Does this account operate a business directly (not just host companies)? */
export async function runsBusiness(prisma: any, id: number): Promise<boolean> {
  const [subs, nas, downline] = await Promise.all([
    prisma.subscriber.count({ where: { userId: id } }),
    prisma.nas.count({ where: { ownerId: id } }),
    prisma.user.count({
      where: { parentId: id, role: { in: DOWNLINE_ROLES } },
    }),
  ]);
  if (subs + nas + downline > 0) return true;
  // A single-business install that never stamped owners: customers with no
  // owner, and no company to belong to but this account.
  const companies = await prisma.user.count({
    where: { role: 'ADMIN', isDemo: false },
  });
  if (companies > 0) return false;
  const [orphanSubs, orphanNas] = await Promise.all([
    prisma.subscriber.count({ where: { userId: null } }),
    prisma.nas.count({ where: { ownerId: null } }),
  ]);
  return orphanSubs + orphanNas > 0;
}

/** superadmin@<same domain>, or a numbered variant if that is taken. */
export async function platformEmailFor(
  prisma: any,
  from: Acct,
): Promise<string> {
  const domain = String(from.email || '').split('@')[1] || 'jointbox.local';
  const candidates = [
    `superadmin@${domain}`,
    `superadmin+${from.id}@${domain}`,
    `superadmin+${Date.now()}@${domain}`,
  ];
  for (const email of candidates) {
    const taken = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!taken) return email;
  }
  return `superadmin+${Date.now()}-${from.id}@${domain}`;
}

async function createPlatformAccount(prisma: any, from: Acct) {
  const email = await platformEmailFor(prisma, from);
  return prisma.user.create({
    data: {
      name: 'Platform Owner',
      email,
      // The same bcrypt hash: whoever knows the company login's password can
      // open the platform login once, and must then choose a new one.
      password: from.password,
      role: 'SUPER_ADMIN',
      isActive: true,
      mustChangePassword: true,
    },
    select: { id: true, email: true },
  });
}

/** Give owner-less business rows to the company that has been running them. */
export async function claimOrphans(
  prisma: any,
  companyId: number,
): Promise<void> {
  const notDemoNas = {
    OR: [
      { server: null },
      { server: { not: process.env.DEMO_NAS_SERVER || 'demo-radius' } },
    ],
  };
  const demoSuffix =
    process.env.DEMO_SUBSCRIBER_EMAIL_SUFFIX || '@example.invalid';
  const notDemoSub = {
    OR: [{ email: null }, { NOT: { email: { endsWith: demoSuffix } } }],
  };
  const owned = [
    'package',
    'ipPool',
    'area',
    'staticIp',
    'inventoryItem',
    'monitorTarget',
    'networkDevice',
    'alertRule',
    'prefixPool',
    'prefixAllocation',
    'uploadedFile',
    'accessGroup',
    'isp',
  ];
  await prisma.nas.updateMany({
    where: { AND: [{ ownerId: null }, notDemoNas] },
    data: { ownerId: companyId },
  });
  await prisma.subscriber.updateMany({
    where: { AND: [{ userId: null }, notDemoSub] },
    data: { userId: companyId },
  });
  for (const model of owned) {
    if (!prisma[model]?.updateMany) continue;
    await prisma[model].updateMany({
      where: { ownerId: null },
      data: { ownerId: companyId },
    });
  }
}

/**
 * Several backend processes boot at once (PM2 cluster + workers). One
 * transaction holding an advisory lock does the work; the others wait for it,
 * then find nothing left to do.
 */
export async function ensurePlatformAccount(
  prisma: any,
  log: { warn: (m: string) => void } = console,
): Promise<PlatformSplitResult> {
  if (typeof prisma.$transaction !== 'function')
    return splitInside(prisma, log);
  return prisma.$transaction(
    async (tx: any) => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(727274001)');
      return splitInside(tx, log);
    },
    { maxWait: 60_000, timeout: 120_000 },
  );
}

async function splitInside(
  prisma: any,
  log: { warn: (m: string) => void },
): Promise<PlatformSplitResult> {
  const select = { id: true, email: true, password: true, name: true };
  const owners: Acct[] = await prisma.user.findMany({
    where: { role: 'SUPER_ADMIN', isActive: true, isDemo: false },
    orderBy: { id: 'asc' },
    select,
  });

  if (owners.length === 0) {
    const root: Acct | null = await prisma.user.findFirst({
      where: { role: 'ADMIN', parentId: null, isActive: true, isDemo: false },
      orderBy: { id: 'asc' },
      select,
    });
    if (!root) return { action: 'none' };
    if (!(await runsBusiness(prisma, root.id))) {
      await prisma.user.update({
        where: { id: root.id },
        data: { role: 'SUPER_ADMIN' },
      });
      await prisma.user.updateMany({
        where: {
          role: 'ADMIN',
          parentId: null,
          isDemo: false,
          id: { not: root.id },
        },
        data: { parentId: root.id },
      });
      log.warn(
        `👑 No platform account existed — ${root.email} is now the platform account (SUPER_ADMIN).`,
      );
      return { action: 'promoted', platformEmail: root.email };
    }
    const p = await createPlatformAccount(prisma, root);
    await prisma.user.updateMany({
      where: { role: 'ADMIN', parentId: null, isDemo: false },
      data: { parentId: p.id },
    });
    await claimOrphans(prisma, root.id);
    log.warn(
      `👑 Platform account created: ${p.email} — sign in with the same password as ${root.email} ` +
        `(you will be asked to change it). ${root.email} keeps running its company.`,
    );
    return {
      action: 'split',
      platformEmail: p.email,
      companyEmail: root.email,
    };
  }

  let result: PlatformSplitResult = { action: 'none' };
  for (const sa of owners) {
    if (!(await runsBusiness(prisma, sa.id))) continue;
    const p = await createPlatformAccount(prisma, sa);
    // Other companies hosted under this account move up to the platform —
    // left under it, they would become part of its company.
    await prisma.user.updateMany({
      where: { parentId: sa.id, role: 'ADMIN' },
      data: { parentId: p.id },
    });
    await prisma.user.update({
      where: { id: sa.id },
      data: { role: 'ADMIN', parentId: p.id },
    });
    await claimOrphans(prisma, sa.id);
    log.warn(
      `👑 ${sa.email} was running a business from the platform account, so it is now that company's ADMIN ` +
        `(same login, same data). Platform account: ${p.email} — same password, change it at first sign-in.`,
    );
    result = {
      action: 'split',
      platformEmail: p.email,
      companyEmail: sa.email,
    };
  }
  return result;
}
