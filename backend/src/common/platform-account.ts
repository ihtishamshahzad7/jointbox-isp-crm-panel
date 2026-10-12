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

import * as bcrypt from 'bcrypt';

/**
 * The platform login every installation ships with. Known, like any
 * installer default — which is why the panel refuses to be used on it: the
 * first sign-in must choose a new password (mustChangePassword).
 */
export const PLATFORM_DEFAULT_EMAIL = (process.env.PLATFORM_ADMIN_EMAIL || 'superadmin@jointbox.com').trim().toLowerCase();
const PLATFORM_DEFAULT_PASSWORD = () => process.env.PLATFORM_ADMIN_PASSWORD || 'admin123';

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

/** superadmin@jointbox.com, else superadmin@<same domain>, else a numbered variant. */
export async function platformEmailFor(
  prisma: any,
  from: Acct,
): Promise<string> {
  const domain = String(from.email || '').split('@')[1] || 'jointbox.local';
  const candidates = [
    PLATFORM_DEFAULT_EMAIL,
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

/**
 * The company keeps its login, but not a name like "Super Admin": the
 * installer's default account name would otherwise show up as a company
 * called "Super Admin" on the platform's Companies screen and in the
 * company's own header. Its ISP's name is used when one exists.
 */
const GENERIC_NAME = /^(super\s*admin|admin(istrator)?|owner|platform\s*owner|root)$/i;
async function nameCompany(prisma: any, company: Acct): Promise<void> {
  if (company.name && !GENERIC_NAME.test(company.name.trim())) return;
  const isp = await prisma.isp
    .findFirst({ where: { OR: [{ ownerId: company.id }, { ownerId: null }] }, orderBy: { id: 'asc' }, select: { name: true } })
    .catch(() => null);
  const name = isp?.name?.trim() || 'My ISP';
  await prisma.user.update({ where: { id: company.id }, data: { name } });
}

async function createPlatformAccount(prisma: any, from: Acct) {
  const email = await platformEmailFor(prisma, from);
  return prisma.user.create({
    data: {
      name: 'Platform Owner',
      email,
      // The installation default (admin123 unless PLATFORM_ADMIN_PASSWORD is
      // set). The first sign-in must choose a new one.
      password: await bcrypt.hash(PLATFORM_DEFAULT_PASSWORD(), 10),
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
    'webhook',
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
    await nameCompany(prisma, root);
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
    await nameCompany(prisma, sa);
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

/**
 * THE PLATFORM LOGIN IS superadmin@jointbox.com — AND admin123 UNTIL ITS OWNER
 * CHOOSES THEIR OWN PASSWORD.
 *
 *  • Email: the platform account always signs in as superadmin@jointbox.com
 *    (PLATFORM_ADMIN_EMAIL), whenever that address is free. Changing it does
 *    not sign anyone out — the session belongs to the account, not the email.
 *  • Password: only a platform account still waiting for its first password
 *    change (mustChangePassword) is put on the default. Once the owner signs
 *    in and picks a password the flag clears, and a password somebody chose is
 *    never overwritten. Every open session is signed out when it is reset.
 */
export async function ensurePlatformLogin(
  prisma: any,
  log: { warn: (m: string) => void },
): Promise<{ email: string; changed: boolean } | null> {
  const sa = await prisma.user.findFirst({
    where: { role: 'SUPER_ADMIN', isDemo: false, isActive: true },
    orderBy: { id: 'asc' },
    select: { id: true, email: true, password: true, mustChangePassword: true },
  });
  if (!sa) return null;

  const data: any = {};
  if (String(sa.email).toLowerCase() !== PLATFORM_DEFAULT_EMAIL) {
    const taken = await prisma.user.findUnique({ where: { email: PLATFORM_DEFAULT_EMAIL }, select: { id: true } });
    if (!taken) data.email = PLATFORM_DEFAULT_EMAIL;
  }
  if (sa.mustChangePassword) {
    const onDefault = !!sa.password && (await bcrypt.compare(PLATFORM_DEFAULT_PASSWORD(), sa.password).catch(() => false));
    if (!onDefault) {
      data.password = await bcrypt.hash(PLATFORM_DEFAULT_PASSWORD(), 10);
      data.tokenVersion = { increment: 1 };
    }
  }
  if (!Object.keys(data).length) return { email: sa.email, changed: false };

  await prisma.user.update({ where: { id: sa.id }, data });
  const email = data.email || sa.email;
  log.warn(
    data.password
      ? `👑 Super admin login: ${email} — default password (PLATFORM_ADMIN_PASSWORD or admin123); it must be changed at first sign-in.`
      : `👑 Super admin login is now ${email} (was ${sa.email}); its password is unchanged.`,
  );
  return { email, changed: true };
}

/**
 * THE INSTALLATION'S CURRENCY BELONGS TO THE PLATFORM, NOT TO A COMPANY.
 *
 * Money is stamped with the currency of "the ISP record" — which used to mean
 * the lowest-id Isp row. Isp rows are now each company's own brands, so the
 * first company to create one set the currency for every company, and a
 * company deleting its brand could change (or blank) it for all of them.
 *
 * The installation currency now lives on a platform row (Isp.ownerId NULL,
 * which no company can edit or delete). On an upgraded server the legacy row
 * already is one. If none exists yet but a company row does, a platform row is
 * created carrying that same currency, so nothing anyone sees changes today and
 * no later company edit can move it. A brand-new server with no Isp row at all
 * is left alone: the platform account sets the currency (Settings), and money
 * is refused until it does — never a guessed default.
 */
export async function ensureInstallationCurrency(
  prisma: any,
  log: { warn: (m: string) => void },
): Promise<boolean> {
  try {
    const platformRow = await prisma.isp.findFirst({ where: { ownerId: null }, select: { id: true } });
    if (platformRow) return false;
    const first = await prisma.isp.findFirst({
      orderBy: { id: 'asc' },
      select: { currency: true, currencySymbol: true },
    });
    if (!first) return false;
    await prisma.isp.create({
      data: {
        ownerId: null,
        name: 'Installation',
        currency: first.currency,
        currencySymbol: first.currencySymbol || first.currency,
      },
    });
    log.warn(`💱 Installation currency pinned to ${first.currency} (platform setting — companies can no longer change it).`);
    return true;
  } catch {
    return false; // table not there yet on a first db:push — next boot does it
  }
}
