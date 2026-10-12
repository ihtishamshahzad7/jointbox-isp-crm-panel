import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { accountStatus, invalidateAccountStatus, PLAN_ENDED_MESSAGE, PUBLISHED_DEFAULT_PASSWORD } from './account-status';

/**
 * How long a switched-in session ("act as", or the platform signed in as a
 * company) may last in total, counted from when it was opened. Refreshing the
 * token no longer extends it past this.
 */
const ACT_AS_MAX_MS = 8 * 3600_000;
const PLATFORM_SUPPORT_MAX_MS = 4 * 3600_000;
const actAsLimitMs = (byRole?: string) => (byRole === 'SUPER_ADMIN' ? PLATFORM_SUPPORT_MAX_MS : ACT_AS_MAX_MS);
type RequestMeta = { ip?: string | null; userAgent?: string | null };
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { LogsService } from '../logs/logs.service';
import { ScopeService, Actor } from '../common/scope.service';
import { EventsService } from '../common/events.service';
import * as bcrypt from 'bcrypt';
import { verifyTotp } from '../security/totp';

@Injectable()
export class AuthService {
  /**
   * A user row as it may leave the server: no password hash, no 2FA seed,
   * no lock-out counters. The 2FA secret was returned on login, verify and
   * impersonation (the frontend kept it in localStorage), so anyone who saw
   * one response — or switched into an account — held its 2FA forever.
   */
  static safeUser<T extends Record<string, any>>(u: T): Omit<T, 'password' | 'twoFactorSecret'> {
    const { password: _p, twoFactorSecret: _t, failedLoginCount: _f, lockedUntil: _l, ...rest } = (u || {}) as any;
    return rest;
  }

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private logsService: LogsService,
    private scope: ScopeService,
    private events: EventsService,
  ) {}

  // Brute-force protection: per email+IP failed-attempt counter. After 8 fails
  // within the window the account/IP pair is locked out for 15 minutes. In
  // memory (per process) — good enough to defeat online guessing; pair with
  // fail2ban / a WAF for network-level protection.
  private loginAttempts = new Map<string, { count: number; until: number }>();
  private static readonly MAX_FAILS = 8;
  private static readonly LOCK_MS = 15 * 60_000;

  private failKey(email: string, ip?: string) {
    return `${(email || '').toLowerCase()}|${ip || ''}`;
  }
  /**
   * Per email+IP, and per email from ANY address: rotating the source address
   * (or a forged X-Forwarded-For) used to give unlimited guesses at one
   * account. The per-account ceiling is higher so one noisy office does not
   * lock a colleague out.
   */
  private static readonly MAX_FAILS_ACCOUNT = 25;
  private assertNotLocked(email: string, ip?: string) {
    const now = Date.now();
    const rec = this.loginAttempts.get(this.failKey(email, ip));
    const acct = this.loginAttempts.get(this.failKey(email, '*'));
    const locked = (rec && rec.count >= AuthService.MAX_FAILS && rec.until > now ? rec : null)
      || (acct && acct.count >= AuthService.MAX_FAILS_ACCOUNT && acct.until > now ? acct : null);
    if (locked) {
      const mins = Math.ceil((locked.until - now) / 60000);
      throw new UnauthorizedException(`Too many failed attempts. Try again in ${mins} minute(s).`);
    }
  }
  private registerFail(email: string, ip?: string) {
    for (const key of [this.failKey(email, ip), this.failKey(email, '*')]) {
      const rec = this.loginAttempts.get(key);
      const count = (rec && rec.until > Date.now() ? rec.count : 0) + 1;
      this.loginAttempts.set(key, { count, until: Date.now() + AuthService.LOCK_MS });
    }
    if (this.loginAttempts.size > 50_000) this.loginAttempts.clear();
  }

  async login(
    email: string,
    password: string,
    ip?: string,
    userAgent?: string,
    code?: string,
  ) {
    // Reject early if this email+IP is currently locked out.
    this.assertNotLocked(email, ip);

    console.log('🔍 Looking for user:', email);

    // Find user in database
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      console.log('❌ User not found:', email);

      // Log failed login attempt
      await this.logsService.createLoginLog({
        email,
        ipAddress: ip || 'Unknown',
        userAgent: userAgent || 'Unknown',
        status: 'FAILED',
        failReason: 'User not found',
      });

      this.registerFail(email, ip);
      throw new UnauthorizedException(
        'Invalid email or password',
      );
    }

    console.log('✅ User found:', user.email);

    // Check password
    const isPasswordValid = await bcrypt.compare(
      password,
      user.password,
    );

    if (!isPasswordValid) {
      console.log('❌ Invalid password for:', email);

      // Log failed login attempt
      await this.logsService.createLoginLog({
        userId: user.id,
        email,
        ipAddress: ip || 'Unknown',
        userAgent: userAgent || 'Unknown',
        status: 'FAILED',
        failReason: 'Invalid credentials',
      });

      this.registerFail(email, ip);
      throw new UnauthorizedException(
        'Invalid email or password',
      );
    }

    // The counters are cleared only once the WHOLE login succeeds (after 2FA
    // below): clearing on a correct password let anyone holding the password
    // guess 6-digit codes without ever being locked out.

    // A suspended account does not log in. Checked AFTER the password, so only
    // someone who already holds the credentials learns the account exists and
    // is suspended — an attacker probing emails gets the same generic answer.
    if (user.isActive === false) {
      await this.logsService.createLoginLog({
        userId: user.id,
        email,
        ipAddress: ip || 'Unknown',
        userAgent: userAgent || 'Unknown',
        status: 'FAILED',
        failReason: 'Account suspended',
      });
      throw new UnauthorizedException('This account is suspended. Contact your provider.');
    }
    // The account above it suspended, or the company's plan with the platform
    // ended: refuse the sign-in itself rather than every request after it.
    const chain = await accountStatus(this.prisma, user.id).catch(() => null);
    if (chain && (!chain.active || chain.planEnded)) {
      const ended = !!chain.planEnded && chain.active;
      await this.logsService.createLoginLog({
        userId: user.id,
        email,
        ipAddress: ip || 'Unknown',
        userAgent: userAgent || 'Unknown',
        status: 'FAILED',
        failReason: ended ? 'Company plan ended' : 'Account above is suspended',
      });
      throw new UnauthorizedException(ended ? PLAN_ENDED_MESSAGE : 'This account is suspended. Contact your provider.');
    }
    console.log('✅ Password valid for:', email);

    // Phase 4A: two-factor authentication
    if (user.twoFactorEnabled) {
      if (!code) {
        // signal the frontend to ask for the 6-digit code (not an error)
        return { requires2fa: true, message: 'Two-factor code required' };
      }
      if (!verifyTotp(user.twoFactorSecret || '', code)) {
        await this.logsService.createLoginLog({
          userId: user.id,
          email,
          ipAddress: ip || 'Unknown',
          userAgent: userAgent || 'Unknown',
          status: 'FAILED',
          failReason: 'Invalid 2FA code',
        });
        this.registerFail(email, ip);
        throw new UnauthorizedException('Invalid two-factor code');
      }
    }
    this.loginAttempts.delete(this.failKey(email, ip));
    this.loginAttempts.delete(this.failKey(email, '*'));

    // Phase 4A: login anomaly flag — first login from a new IP is recorded 🔍
    if (ip && ip !== 'Unknown') {
      const knownIp = await this.prisma.loginLog.findFirst({
        where: { userId: user.id, status: 'SUCCESS', ipAddress: ip },
        select: { id: true },
      });
      if (!knownIp) {
        await this.prisma.activityLog.create({
          data: {
            userId: user.id,
            action: 'NEW_IP_LOGIN',
            entity: 'User',
            entityId: user.id,
            details: `First login from ${ip}`,
            ipAddress: ip,
            userAgent,
          },
        });
      }
    }

    // Log successful login
    await this.logsService.createLoginLog({
      userId: user.id,
      email,
      ipAddress: ip || 'Unknown',
      userAgent: userAgent || 'Unknown',
      status: 'SUCCESS',
    });

    // Create JWT token with longer expiry
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      isDemo: (user as any).isDemo === true,
      // The account's session version: a password change bumps it and every
      // older token stops working (see JwtStrategy).
      tv: Number((user as any).tokenVersion ?? 0),
      // Two sign-ins in the same second must not share one token string —
      // signing out (blacklisting) one would sign out the other.
      jti: randomUUID(),
    };

    const token = this.jwtService.sign(payload, {
      expiresIn: '7d', // Token expires in 7 days
    });

    // Remove password from response
    const userWithoutPassword = AuthService.safeUser(user);

    console.log('🎉 Login successful for:', email);
    this.events.broadcast('login', {
      email: user.email,
      name: user.name,
      role: user.role,
      // Who may see it: the live feed delivers only to accounts above/at it.
      ownerUserId: user.id,
    });

    return {
      message: 'Login successful',
      token,
      user: userWithoutPassword,
    };
  }

  async validateUser(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return AuthService.safeUser(user);
  }

  async verifyToken(token: string) {
    try {
      const decoded = this.jwtService.verify(token);
      const user = await this.validateUser(decoded.sub);
      return { valid: true, user };
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return { valid: false, message: 'Token expired' };
      }
      return { valid: false, message: 'Invalid token' };
    }
  }

  async refreshToken(oldToken: string) {
    try {
      const decoded = this.jwtService.verify(oldToken);
      
      // Get fresh user data
      const user = await this.prisma.user.findUnique({
        where: { id: decoded.sub },
      });

      if (!user) {
        throw new UnauthorizedException('User not found');
      }
      // A refresh is a new session. Without this, a suspended account could
      // keep minting itself 7-day tokens indefinitely.
      if (user.isActive === false) {
        throw new UnauthorizedException('This account is suspended.');
      }
      // A signed-out session (password changed since it was issued) cannot be
      // renewed — refresh used to re-mint any valid token forever.
      if (Number(decoded?.tv ?? 0) !== Number((user as any).tokenVersion ?? 0)) {
        throw new UnauthorizedException('This session has been signed out. Sign in again.');
      }

      // Same claims as login. isDemo was missing here, so a demo session that
      // refreshed its token came back as an ordinary account — and every
      // BlockDemoGuard check reads that claim.
      const payload: Record<string, unknown> = {
        sub: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
        isDemo: (user as any).isDemo === true,
        tv: Number((user as any).tokenVersion ?? 0),
        jti: randomUUID(),
      };

      /**
       * An "act as" session stays one. Refreshing it used to drop `imp`, which
       * turned a 1-day, audited impersonation into an ordinary 7-day login as
       * the target: no switch-back, and every later action attributed to the
       * target instead of the operator who was really at the keyboard. The
       * operator who started it must still be active, too.
       */
      let actAsSecondsLeft = 0;
      if (decoded?.imp?.by) {
        const by = await this.prisma.user.findUnique({
          where: { id: Number(decoded.imp.by) },
          select: { isActive: true },
        });
        if (!by || by.isActive === false) {
          throw new UnauthorizedException('The operator who started this session is no longer active.');
        }
        // A switched-in session ends at its time limit, however often it is
        // refreshed. Sessions opened before the limit existed start counting now.
        const startedAt = Number(decoded.imp.at) || Date.now();
        const left = actAsLimitMs(decoded.imp.byRole) - (Date.now() - startedAt);
        if (left <= 0) {
          throw new UnauthorizedException('This switched-in session has ended. Switch in again if you still need it.');
        }
        actAsSecondsLeft = Math.max(60, Math.floor(left / 1000));
        payload.imp = { ...decoded.imp, at: startedAt };
      }

      const newToken = this.jwtService.sign(payload, {
        expiresIn: actAsSecondsLeft ? actAsSecondsLeft : '7d',
      });

      return { token: newToken };
    } catch (error) {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  // ─────────────────────────────────────────────────────────────
  // PROFILE SWITCH ("act as") — scoped to the actor's subtree.
  // ISP can act as any downstream user; a dealer only its own downline.
  // The issued token carries `imp.by` so the session can switch back and
  // every action is auditable back to the real operator.
  // ─────────────────────────────────────────────────────────────
  /** Audit rows that must never fail the action they describe. */
  private async logQuietly(args: { data: any[] }): Promise<void> {
    try {
      await (this.prisma.activityLog as any).createMany(args);
    } catch {
      /* logging is best-effort */
    }
  }

  async impersonate(actor: any, targetUserId: number, meta: RequestMeta = {}) {
    /**
     * Only into accounts strictly BELOW the caller. Staff and auditors do not
     * switch accounts at all: a staff member's scope is its owner's, so the
     * old subtree check let a company's staff member sign in AS the company.
     */
    if (actor?.role === 'SALES' || actor?.role === 'AUDITOR') {
      throw new ForbiddenException('Staff and auditor accounts cannot switch into other accounts.');
    }
    const scopeActor: Actor = { sub: actor?.sub, role: actor?.role };
    await this.scope.assertUser(scopeActor, targetUserId);

    const target = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw new UnauthorizedException('Target user not found');
    if (target.id === actor?.sub) throw new UnauthorizedException('Already on this account');
    if (actor?.role !== 'SUPER_ADMIN') {
      if (target.role === 'ADMIN' || target.role === 'SUPER_ADMIN') {
        throw new ForbiddenException('You cannot switch into a company or platform account.');
      }
      const below = await this.scope.descendantIds(Number(actor?.sub));
      if (!below.includes(target.id)) throw new ForbiddenException('This account is outside your hierarchy.');
    }
    // The platform account opens a COMPANY (to support it); people inside the
    // company are reached from there, never straight from the platform.
    if (actor?.role === 'SUPER_ADMIN' && target.role !== 'ADMIN') {
      throw new ForbiddenException('Sign in as the company first, then switch to its staff or resellers from inside it.');
    }

    // The real operator is the ORIGINAL root (preserved across nested switches),
    // and so is the moment the switched-in session began (its time limit).
    const rootBy = actor?.imp?.by ?? actor?.sub;
    const rootName = actor?.imp?.byName ?? actor?.name;
    const rootRole = actor?.imp?.byRole ?? actor?.role;
    const startedAt = Number(actor?.imp?.at) || Date.now();
    const leftMs = actAsLimitMs(rootRole) - (Date.now() - startedAt);
    if (leftMs <= 0) throw new UnauthorizedException('This switched-in session has ended. Switch back and start again.');

    /**
     * Two audit rows: one in the operator's own log, and one in the log of the
     * account being entered — so a company can see when the platform (or a
     * parent) signed in to it, from where, and for how long.
     */
    const who = rootRole === 'SUPER_ADMIN' ? `Platform support (${rootName})` : `${rootName} (${rootRole})`;
    await this.logQuietly({
      data: [
        {
          userId: rootBy,
          action: 'IMPERSONATE',
          entity: 'User',
          entityId: target.id,
          details: `${rootName} (${rootRole}) switched into ${target.name} (${target.role})`,
          ipAddress: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
        },
        {
          userId: target.id,
          action: rootRole === 'SUPER_ADMIN' ? 'PLATFORM_SUPPORT_SIGNIN' : 'SIGNED_IN_AS',
          entity: 'User',
          entityId: target.id,
          details: `${who} signed in to this account`,
          ipAddress: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
        },
      ],
    });

    const token = this.jwtService.sign(
      {
        sub: target.id,
        email: target.email,
        role: target.role,
        name: target.name,
        imp: { by: rootBy, byName: rootName, byRole: rootRole, at: startedAt },
        isDemo: (target as any).isDemo === true,
        tv: Number((target as any).tokenVersion ?? 0),
        jti: randomUUID(),
      },
      { expiresIn: Math.max(60, Math.floor(leftMs / 1000)) },
    );

    const user = AuthService.safeUser(target);
    return { token, user, impersonating: true, actingAs: target.name };
  }

  /** Return to the original operator's account. */
  async stopImpersonation(actor: any, meta: RequestMeta = {}) {
    const backTo = actor?.imp?.by;
    if (!backTo) throw new UnauthorizedException('Not currently switched into another account');

    const user = await this.prisma.user.findUnique({ where: { id: backTo } });
    if (!user) throw new UnauthorizedException('Original account not found');

    // Close the session in both logs, with how long it lasted.
    const mins = actor?.imp?.at ? Math.max(1, Math.round((Date.now() - Number(actor.imp.at)) / 60000)) : null;
    const who = actor?.imp?.byRole === 'SUPER_ADMIN' ? `Platform support (${actor?.imp?.byName})` : `${actor?.imp?.byName} (${actor?.imp?.byRole})`;
    const took = mins ? ` after ${mins} min` : '';
    await this.logQuietly({
      data: [
        { userId: Number(backTo), action: 'IMPERSONATE_END', entity: 'User', entityId: Number(actor?.sub), details: `Switched back from account #${actor?.sub}${took}`, ipAddress: meta.ip ?? null, userAgent: meta.userAgent ?? null },
        { userId: Number(actor?.sub), action: 'SIGNED_OUT_AS', entity: 'User', entityId: Number(actor?.sub), details: `${who} left this account${took}`, ipAddress: meta.ip ?? null, userAgent: meta.userAgent ?? null },
      ],
    });

    const token = this.jwtService.sign(
      {
        sub: user.id, email: user.email, role: user.role, name: user.name,
        isDemo: (user as any).isDemo === true,
        tv: Number((user as any).tokenVersion ?? 0),
        jti: randomUUID(),
      },
      { expiresIn: '7d' },
    );
    const safe = AuthService.safeUser(user);
    return { token, user: safe, impersonating: false };
  }

  /**
   * "Where is the super admin?" — for the company that was running this
   * server before the platform login existed (it predates the platform
   * account and sits directly under it). Every other company gets nothing:
   * a tenant has no business knowing the platform login.
   */
  async platformHint(userId: number, impersonated: boolean) {
    if (impersonated) return { platformEmail: null };
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, parentId: true } });
    if (!me || me.role !== 'ADMIN' || !me.parentId) return { platformEmail: null };
    const parent = await this.prisma.user.findUnique({
      where: { id: me.parentId },
      select: { id: true, role: true, email: true, mustChangePassword: true, isActive: true },
    });
    if (!parent || parent.role !== 'SUPER_ADMIN' || !parent.isActive || parent.id < me.id) return { platformEmail: null };
    return { platformEmail: parent.email, firstSignIn: !!parent.mustChangePassword };
  }

  async getProfile(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        // Wallet balance is returned so the shell can show it in the top bar.
        // Every reseller needs it in front of them constantly — it is what
        // decides whether their next activation will go through, and finding
        // out only at the point of failure wastes the customer's visit.
        balance: true,
        // The header shows the signed-in person's own picture. Without this in
        // the select the avatar silently falls back to initials forever, which
        // reads as "uploads don't work" rather than "field not requested".
        photoUrl: true,
        parentId: true,
        canTopupDownline: true,
        canSetPackagePrice: true,
        // The shell reads this to send a first-boot admin straight to the
        // change-password screen instead of a dashboard full of 403s.
        mustChangePassword: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return user;
  }

  /**
   * An operator changes their own password.
   *
   * There was no way to do this for staff accounts at all — the only
   * change-password route belonged to the subscriber portal — so the first-boot
   * admin created from the published default could only be fixed by another
   * admin editing the account, and there is no other admin on a new server.
   *
   * Returns a fresh token, and blacklists the one used to make the request:
   * a password change is exactly when an old session should stop, because the
   * reason for changing it may be that someone else has it.
   */
  async changeOwnPassword(userId: number, currentPassword: string, newPassword: string, oldToken?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');

    if (!currentPassword || !(await bcrypt.compare(currentPassword, user.password))) {
      throw new BadRequestException('Your current password is not correct.');
    }
    const next = String(newPassword || '');
    if (next.length < 8) {
      throw new BadRequestException('Use at least 8 characters.');
    }
    if (next === currentPassword) {
      throw new BadRequestException('Choose a password different from the current one.');
    }
    if (next === PUBLISHED_DEFAULT_PASSWORD) {
      throw new BadRequestException('That is the published default password. Choose your own.');
    }

    // Bump the session version: every other session of this account ends —
    // the reason for changing a password is often that someone else has it.
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { password: await bcrypt.hash(next, 10), mustChangePassword: false, tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    });
    invalidateAccountStatus(userId);

    const token = this.jwtService.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
        isDemo: (user as any).isDemo === true,
        tv: Number(updated.tokenVersion ?? 0),
        // Unique per issue: signed in the same second as the old token, an
        // identical payload produced the IDENTICAL string — and blacklisting
        // the old token then revoked the new one too.
        jti: randomUUID(),
      },
      { expiresIn: '7d' },
    );
    return { message: 'Password changed', token, oldToken };
  }
}