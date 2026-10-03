import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DEMO_NAS_SERVER, DEMO_SUBSCRIBER_EMAIL_SUFFIX } from '../common/scope.service';
import { LicenceService, licensingDisabled } from './licence.service';

/**
 * PLAN CAPACITY — the panel's half of a decision made on the licence server.
 *
 * ── The division of labour ───────────────────────────────────────────────
 * This file contains NO opinion about what a plan allows. The licence server
 * resolves the plan, any per-customer override, and the overage percentage,
 * and signs TWO numbers into the licence: `cap_hard` (the count at which a new
 * record is refused) and `max_nas`. All this does is compare a count to a
 * number it was given.
 *
 * That split is deliberate. The policy lives in one place, where it can be
 * changed per customer without a release, and it arrives inside an Ed25519
 * signature, so the customer — who has root on this box — cannot soften it by
 * editing TypeScript. If the arithmetic lived here, every pricing change would
 * be a deployment and every deployment a chance to get it wrong.
 *
 * ── What it must never do ────────────────────────────────────────────────
 * Touch anybody already connected. Going over the cap refuses the NEXT record
 * and nothing else: existing subscribers keep authenticating, keep accounting,
 * keep their bandwidth. FreeRADIUS reads Postgres directly and never asks this
 * API, so that guarantee is structural rather than a promise this file makes.
 *
 * It also fails open in every uncertain state — licensing disabled, agent not
 * running, a licence server too old to send `cap_hard`. An ISP must never be
 * unable to add a customer because OUR service is confused.
 *
 * ── Why not count() ──────────────────────────────────────────────────────
 * `SELECT COUNT(*)` on Subscriber is a full scan, and this runs on the hot
 * path of every create. We do not need the count — only whether it has reached
 * one number. `OFFSET cap-1 LIMIT 1` makes Postgres stop as soon as it has
 * seen `cap` rows, so the work is bounded by the plan size (800 rows on Basic)
 * no matter how large the table grows.
 *
 * The thing being counted must match what `licence-counts.service.ts` reports
 * in the heartbeat — a plain, unscoped `subscriber.count()`. If the two ever
 * diverge, the licence server flags a customer as over-plan while their panel
 * says they are fine, and support is left arguing with a number.
 */
@Injectable()
export class LicenceCapacityService {
  private readonly log = new Logger(LicenceCapacityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly licence: LicenceService,
  ) {}

  /**
   * Throws 402 when this installation has reached its subscriber cap.
   * Call immediately before creating a subscriber.
   */
  async assertCanAddSubscriber(): Promise<void> {
    const cap = this.licence.capHard;
    if (!this.enforcing(cap)) return;

    if (await this.atLeast('Subscriber', cap)) {
      throw this.refuse(
        'subscribers',
        cap,
        this.licence.maxSubscribers,
        `This installation has reached the ${this.planName()} plan limit of ` +
          `${this.licence.maxSubscribers.toLocaleString()} subscribers.`,
      );
    }
  }

  /** Same contract, for NAS devices. */
  async assertCanAddNas(): Promise<void> {
    const cap = this.licence.maxNas;
    if (!this.enforcing(cap)) return;

    if (await this.atLeast('Nas', cap)) {
      throw this.refuse(
        'NAS devices',
        cap,
        cap,
        `This installation has reached the ${this.planName()} plan limit of ` +
          `${cap.toLocaleString()} NAS devices.`,
      );
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * Every reason to let the create through. Each one is a case where refusing
   * would mean punishing a customer for our own uncertainty.
   */
  private enforcing(cap: number): boolean {
    if (licensingDisabled()) return false;
    // No verified entitlement: agent missing, stopped, or never installed.
    if (!this.licence.hasEntitlement) return false;
    // 0 is the unlimited convention, and is also what an older licence server
    // that predates the cap-policy migration sends. Both mean "do not refuse".
    if (!cap || cap <= 0) return false;
    return true;
  }

  /**
   * True when the table holds at least `n` rows, without counting the rest.
   *
   * The table name is interpolated, which would normally be an injection
   * hazard — it is safe only because the two call sites pass string literals.
   * Keep it that way: no caller may pass a name that came from a request.
   */
  /**
   * Two explicit queries rather than one interpolated table name, for two
   * reasons that were both live bugs:
   *
   *   • the NAS model maps to the FreeRADIUS table `nas` (@@map), so the old
   *     query quoted the model name, a table that does not exist. Every NAS capacity
   *     check threw, the catch below allowed the create, and the router cap
   *     was never enforced at all;
   *   • neither query excluded the demo sandbox, so a 25-subscriber trial saw
   *     10,016 rows and refused real customers on behalf of invented ones.
   *
   * The demo rules here are the SQL spelling of NON_DEMO_SUBSCRIBER and
   * NON_DEMO_OWNED in scope.service.ts — owner flag AND row marker.
   */
  private async atLeast(table: 'Subscriber' | 'Nas', n: number): Promise<boolean> {
    try {
      const sql =
        table === 'Subscriber'
          ? `SELECT 1 AS one FROM "Subscriber" s
               WHERE (s."userId" IS NULL OR NOT EXISTS (
                        SELECT 1 FROM "User" u WHERE u.id = s."userId" AND u."isDemo" = true))
                 AND (s.email IS NULL OR s.email NOT LIKE '%' || $2)
               OFFSET $1 LIMIT 1`
          : `SELECT 1 AS one FROM nas n
               WHERE (n."ownerId" IS NULL OR NOT EXISTS (
                        SELECT 1 FROM "User" u WHERE u.id = n."ownerId" AND u."isDemo" = true))
                 AND (n.server IS NULL OR n.server <> $2)
               OFFSET $1 LIMIT 1`;
      const marker = table === 'Subscriber' ? DEMO_SUBSCRIBER_EMAIL_SUFFIX : DEMO_NAS_SERVER;
      const rows = await this.prisma.$queryRawUnsafe<Array<{ one: number }>>(sql, n - 1, marker);
      return rows.length > 0;
    } catch (err) {
      // A failed capacity check must not block a create. Licensing is not
      // worth an outage, and a database that cannot answer this probably has
      // larger problems than one subscriber over a plan limit.
      this.log.warn(
        `capacity check on ${table} failed, allowing the create: ${(err as Error).message}`,
      );
      return false;
    }
  }

  private planName(): string {
    const p = this.licence.status().plan;
    return typeof p === 'string' && p ? p : 'current';
  }

  /**
   * 402, matching LicenceGuard, so the frontend's existing interceptor shows
   * the licence dialog rather than a generic "request failed" toast.
   *
   * `detail` is the most important field on this object. An operator who has
   * just been refused needs to know, in the same breath, that nobody went
   * offline — otherwise the next thing they do is panic.
   */
  private refuse(noun: string, hard: number, sold: number, message: string): HttpException {
    const overage = hard > sold ? ` (${hard.toLocaleString()} including your overage allowance)` : '';
    return new HttpException(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: 'LICENCE_CAP_REACHED',
        resource: noun,
        limit: sold,
        hardLimit: hard,
        message: message + overage + ' Upgrade the plan to add more.',
        detail:
          `Every existing ${noun === 'subscribers' ? 'subscriber' : 'device'} is unaffected — ` +
          'nobody has been disconnected and nothing has been suspended. ' +
          'Authentication, accounting and bandwidth control are untouched. ' +
          'Only creating a new record is held back.',
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
