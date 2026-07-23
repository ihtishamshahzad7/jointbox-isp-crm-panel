import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';

/**
 * One step in the guided setup.
 *
 * `status` is deliberately three-valued rather than a boolean:
 *
 *   ok      — done, nothing to do
 *   todo    — not done, and you CAN do it now
 *   blocked — not done, and an earlier step must happen first
 *
 * The distinction matters. Most of the time lost in this panel has been spent
 * on actions that were refused for a reason shown nowhere, so a step that
 * cannot yet be done must say what is holding it up rather than simply
 * appearing incomplete.
 */
export type StepStatus = 'ok' | 'todo' | 'blocked';

export interface SetupStep {
  id: string;
  title: string;
  /** Why this matters, in one plain sentence. */
  why: string;
  status: StepStatus;
  /** What is true right now — a count, a name, a reason. */
  detail: string;
  /** Where to go to fix it. */
  fixHref?: string;
  fixLabel?: string;
  /** When blocked: the id of the step that must happen first. */
  blockedBy?: string;
}

@Injectable()
export class SetupService {
  constructor(private prisma: PrismaService, private scope: ScopeService) {}

  /**
   * Assemble the checklist for whoever is asking.
   *
   * The ISP and a reseller have genuinely different jobs — the ISP builds the
   * catalogue and the network, a reseller prices and sells what they were
   * given — so they get different lists rather than one list with half the
   * rows greyed out.
   */
  async status(actor: Actor) {
    const isIsp = this.scope.isAdmin(actor?.role);
    const meId = await this.scope.rootId(actor);
    const me = await this.prisma.user.findUnique({
      where: { id: meId },
      select: { id: true, name: true, role: true, balance: true, parentId: true,
                canSetPackagePrice: true, canAddNas: true },
    });

    const steps = isIsp ? await this.ispSteps(actor, meId) : await this.resellerSteps(actor, me!);

    const done = steps.filter((s) => s.status === 'ok').length;
    return {
      account: me?.name,
      role: me?.role,
      isIsp,
      done,
      total: steps.length,
      complete: done === steps.length,
      /** The one thing to do next — the first actionable step. */
      nextStep: steps.find((s) => s.status === 'todo') ?? null,
      steps,
    };
  }

  // ── ISP: build the catalogue, the network, and the first franchise ──
  private async ispSteps(actor: Actor, meId: number): Promise<SetupStep[]> {
    const [packages, pools, nasList, children] = await Promise.all([
      this.prisma.package.count(),
      this.prisma.ipPool.count(),
      this.prisma.nas.findMany({ select: { id: true, nasname: true, isActive: true } }),
      this.prisma.user.findMany({
        where: { parentId: meId },
        select: { id: true, name: true, balance: true, canSetPackagePrice: true },
      }),
    ]);

    const steps: SetupStep[] = [];

    steps.push({
      id: 'package',
      title: 'Create at least one package',
      why: 'A package is the speed and price customers actually buy. Nothing else can be set up until one exists.',
      status: packages > 0 ? 'ok' : 'todo',
      detail: packages > 0 ? `${packages} package(s) created` : 'No packages yet',
      fixHref: '/packages', fixLabel: 'Create a package',
    });

    steps.push({
      id: 'nas',
      title: 'Register your router',
      why: 'The NAS is what your customers dial into. Without it RADIUS has nothing to authenticate against.',
      status: nasList.length > 0 ? 'ok' : 'todo',
      detail: nasList.length > 0
        ? `${nasList.length} router(s): ${nasList.map((n) => n.nasname).join(', ')}`
        : 'No routers registered',
      fixHref: '/nas', fixLabel: 'Add a router',
    });

    steps.push({
      id: 'pool',
      title: 'Create an IP pool',
      why: 'Customers need an address. The pool is attached to the package and sent to the router as Framed-Pool.',
      status: pools > 0 ? 'ok' : 'todo',
      detail: pools > 0 ? `${pools} pool(s)` : 'No IP pools yet',
      fixHref: '/ip-pools', fixLabel: 'Create a pool',
    });

    steps.push({
      id: 'franchise',
      title: 'Create your first franchise or dealer',
      why: 'Resellers are how you sell without doing every installation yourself. Skip this only if you sell entirely direct.',
      status: children.length > 0 ? 'ok' : 'todo',
      detail: children.length > 0
        ? `${children.length} account(s): ${children.map((c) => c.name).join(', ')}`
        : 'No reseller accounts yet',
      fixHref: '/organization', fixLabel: 'Create an account',
    });

    // Everything below depends on having a child to configure.
    const hasChild = children.length > 0;
    const childIds = children.map((c) => c.id);

    const priced = hasChild
      ? await this.prisma.resellerPackagePrice.count({ where: { userId: { in: childIds } } })
      : 0;

    steps.push({
      id: 'price',
      title: 'Set what your resellers pay',
      why: 'Until a price exists, an activation cannot be costed and their wallet cannot be charged.',
      status: !hasChild ? 'blocked' : priced > 0 ? 'ok' : 'todo',
      blockedBy: !hasChild ? 'franchise' : undefined,
      detail: !hasChild ? 'Create a reseller account first'
        : priced > 0 ? `${priced} price(s) set` : 'No prices set — activations will fail',
      fixHref: '/pricing', fixLabel: 'Set prices',
    });

    const unpricedChildren = children.filter((c) => c.canSetPackagePrice === false);
    steps.push({
      id: 'permission',
      title: 'Let your resellers price their own downline',
      why: 'A franchise that cannot price its dealers cannot trade at all. Older accounts have this switched off.',
      status: !hasChild ? 'blocked' : unpricedChildren.length === 0 ? 'ok' : 'todo',
      blockedBy: !hasChild ? 'franchise' : undefined,
      detail: !hasChild ? 'Create a reseller account first'
        : unpricedChildren.length === 0 ? 'All accounts can set prices'
        : `${unpricedChildren.map((c) => c.name).join(', ')} cannot set prices`,
      fixHref: '/organization', fixLabel: 'Grant permission',
    });

    const sharedNas = hasChild
      ? await this.prisma.nasAssignment.count({ where: { userId: { in: childIds } } })
      : 0;
    steps.push({
      id: 'share-nas',
      title: 'Share a router with your resellers',
      why: 'Their subscribers authenticate against your router. Share once with a franchise and their whole downline inherits it.',
      status: !hasChild || nasList.length === 0 ? 'blocked' : sharedNas > 0 ? 'ok' : 'todo',
      blockedBy: nasList.length === 0 ? 'nas' : !hasChild ? 'franchise' : undefined,
      detail: nasList.length === 0 ? 'Register a router first'
        : !hasChild ? 'Create a reseller account first'
        : sharedNas > 0 ? `Shared with ${sharedNas} account(s)` : 'Not shared — their subscribers cannot connect',
      fixHref: '/nas', fixLabel: 'Share a router',
    });

    const sharedPool = hasChild
      ? await this.prisma.ipPoolAssignment.count({ where: { userId: { in: childIds } } })
      : 0;
    steps.push({
      id: 'share-pool',
      title: 'Share your IP pool',
      why: 'Needed only if you want them assigning static IPs by hand. Automatic addressing already follows the package.',
      status: !hasChild || pools === 0 ? 'blocked' : sharedPool > 0 ? 'ok' : 'todo',
      blockedBy: pools === 0 ? 'pool' : !hasChild ? 'franchise' : undefined,
      detail: pools === 0 ? 'Create a pool first'
        : !hasChild ? 'Create a reseller account first'
        : sharedPool > 0 ? `Shared with ${sharedPool} account(s)` : 'Optional — not shared yet',
      fixHref: '/ip-pools', fixLabel: 'Share a pool',
    });

    const funded = children.filter((c) => (c.balance ?? 0) > 0);
    steps.push({
      id: 'wallet',
      title: 'Top up a reseller wallet',
      why: 'Prepaid: an account with an empty wallet can create subscribers but cannot activate them.',
      status: !hasChild ? 'blocked' : funded.length > 0 ? 'ok' : 'todo',
      blockedBy: !hasChild ? 'franchise' : undefined,
      detail: !hasChild ? 'Create a reseller account first'
        : funded.length > 0 ? `${funded.length} of ${children.length} account(s) funded`
        : 'All wallets empty — nobody can activate',
      fixHref: '/organization', fixLabel: 'Add balance',
    });

    const subs = await this.prisma.subscriber.count();
    steps.push({
      id: 'subscriber',
      title: 'Activate your first subscriber',
      why: 'The end-to-end test: wallet charged, RADIUS credentials written, customer online.',
      status: subs > 0 ? 'ok' : packages > 0 && nasList.length > 0 ? 'todo' : 'blocked',
      blockedBy: packages === 0 ? 'package' : nasList.length === 0 ? 'nas' : undefined,
      detail: subs > 0 ? `${subs} subscriber(s)` : 'None yet',
      fixHref: '/subscribers', fixLabel: 'Add a subscriber',
    });

    return steps;
  }

  // ── Reseller: price what you were given, then sell it ──
  private async resellerSteps(actor: Actor, me: any): Promise<SetupStep[]> {
    const meId = me.id;
    const [myPrices, children, subs, nasWhere] = await Promise.all([
      this.prisma.resellerPackagePrice.findMany({
        where: { userId: meId },
        select: { packageId: true, price: true, retailPrice: true },
      }),
      this.prisma.user.findMany({ where: { parentId: meId }, select: { id: true, name: true } }),
      this.prisma.subscriber.count({ where: { userId: meId } }),
      this.scope.nasWhere(actor),
    ]);
    const nasCount = await this.prisma.nas.count({ where: nasWhere });

    const steps: SetupStep[] = [];

    /**
     * The first step is not something they DO — it is something their parent
     * must have done. Showing it makes an otherwise invisible dependency
     * obvious, instead of leaving them to discover it when a save is refused.
     */
    const bought = myPrices.filter((p) => p.price > 0);
    steps.push({
      id: 'my-cost',
      title: 'Your parent has set what you pay',
      why: 'Your buy price is set by the account above you. Until it exists you cannot be charged, so you cannot activate.',
      status: bought.length > 0 ? 'ok' : 'blocked',
      detail: bought.length > 0
        ? `${bought.length} package(s) priced to you`
        : 'No packages priced to you yet — ask your parent account to set your price',
      fixHref: '/pricing', fixLabel: 'View pricing',
    });

    const withRetail = myPrices.filter((p) => p.retailPrice != null && p.retailPrice > 0);
    steps.push({
      id: 'my-retail',
      title: 'Set what your customers pay',
      why: 'Your profit is this price minus what you pay. Without it, customers get billed the base price and you may lose money.',
      status: bought.length === 0 ? 'blocked' : withRetail.length > 0 ? 'ok' : 'todo',
      blockedBy: bought.length === 0 ? 'my-cost' : undefined,
      detail: bought.length === 0 ? 'Wait for your buy price first'
        : withRetail.length > 0 ? `${withRetail.length} package(s) have your selling price`
        : 'Not set — customers will be billed the base price',
      fixHref: '/pricing', fixLabel: 'Set my price',
    });

    steps.push({
      id: 'nas',
      title: 'A router is available to you',
      why: 'Your subscribers authenticate against it. Either you registered one, or your parent shared theirs.',
      status: nasCount > 0 ? 'ok' : 'blocked',
      detail: nasCount > 0
        ? `${nasCount} router(s) available`
        : 'None — ask your parent to share a router with you',
      fixHref: '/nas', fixLabel: 'View routers',
    });

    steps.push({
      id: 'wallet',
      title: 'Your wallet has balance',
      why: 'Every activation deducts your buy price. At zero, subscribers can be created but not activated.',
      status: (me.balance ?? 0) > 0 ? 'ok' : 'todo',
      detail: (me.balance ?? 0) > 0
        ? `Balance ${Number(me.balance).toFixed(0)}`
        : 'Empty — ask your parent account to top you up',
      fixHref: '/accounting', fixLabel: 'View wallet',
    });

    // Only relevant if they resell onward. Not everyone does, so it is framed
    // as optional rather than incomplete.
    if (children.length > 0) {
      const childPriced = await this.prisma.resellerPackagePrice.count({
        where: { userId: { in: children.map((c) => c.id) } },
      });
      steps.push({
        id: 'price-children',
        title: 'Price your own accounts',
        why: 'Your downline cannot activate anything until you set what they pay you.',
        status: childPriced > 0 ? 'ok' : me.canSetPackagePrice === false ? 'blocked' : 'todo',
        detail: me.canSetPackagePrice === false
          ? 'Price-setting is switched off for your account — ask the ISP to enable it'
          : childPriced > 0 ? `${childPriced} price(s) set`
          : `${children.length} account(s) below you have no price`,
        fixHref: '/pricing', fixLabel: 'Set their prices',
      });
    }

    steps.push({
      id: 'subscriber',
      title: 'Add your first customer',
      why: 'Everything above exists so this works: wallet charged, credentials written, customer online.',
      status: subs > 0 ? 'ok' : (bought.length > 0 && nasCount > 0) ? 'todo' : 'blocked',
      blockedBy: bought.length === 0 ? 'my-cost' : nasCount === 0 ? 'nas' : undefined,
      detail: subs > 0 ? `${subs} customer(s)` : 'None yet',
      fixHref: '/subscribers', fixLabel: 'Add a customer',
    });

    return steps;
  }
}
