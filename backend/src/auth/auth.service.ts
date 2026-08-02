import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { LogsService } from '../logs/logs.service';
import { ScopeService, Actor } from '../common/scope.service';
import { EventsService } from '../common/events.service';
import * as bcrypt from 'bcrypt';
import { verifyTotp } from '../security/totp';

@Injectable()
export class AuthService {
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
  private assertNotLocked(email: string, ip?: string) {
    const rec = this.loginAttempts.get(this.failKey(email, ip));
    if (rec && rec.count >= AuthService.MAX_FAILS && rec.until > Date.now()) {
      const mins = Math.ceil((rec.until - Date.now()) / 60000);
      throw new UnauthorizedException(`Too many failed attempts. Try again in ${mins} minute(s).`);
    }
  }
  private registerFail(email: string, ip?: string) {
    const key = this.failKey(email, ip);
    const rec = this.loginAttempts.get(key);
    const count = (rec && rec.until > Date.now() ? rec.count : 0) + 1;
    this.loginAttempts.set(key, { count, until: Date.now() + AuthService.LOCK_MS });
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

    // Correct password → clear the failed-attempt counter for this email+IP.
    this.loginAttempts.delete(this.failKey(email, ip));
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
        throw new UnauthorizedException('Invalid two-factor code');
      }
    }

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
    };

    const token = this.jwtService.sign(payload, {
      expiresIn: '7d', // Token expires in 7 days
    });

    // Remove password from response
    const { password: _, ...userWithoutPassword } = user;

    console.log('🎉 Login successful for:', email);
    this.events.broadcast('login', {
      email: user.email,
      name: user.name,
      role: user.role,
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

    const { password: _, ...userWithoutPassword } = user;
    return userWithoutPassword;
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

      // Create new token
      const payload = {
        sub: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
      };

      const newToken = this.jwtService.sign(payload, {
        expiresIn: '7d',
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
  async impersonate(actor: any, targetUserId: number) {
    // Only the ISP/admin, or someone whose subtree contains the target, may switch in.
    const scopeActor: Actor = { sub: actor?.sub, role: actor?.role };
    await this.scope.assertUser(scopeActor, targetUserId);

    const target = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw new UnauthorizedException('Target user not found');
    if (target.id === actor?.sub) throw new UnauthorizedException('Already on this account');

    // The real operator is the ORIGINAL root (preserved across nested switches).
    const rootBy = actor?.imp?.by ?? actor?.sub;
    const rootName = actor?.imp?.byName ?? actor?.name;
    const rootRole = actor?.imp?.byRole ?? actor?.role;

    // Audit trail
    await this.prisma.activityLog.create({
      data: {
        userId: rootBy,
        action: 'IMPERSONATE',
        entity: 'User',
        entityId: target.id,
        details: `${rootName} (${rootRole}) switched into ${target.name} (${target.role})`,
      },
    }).catch(() => null);

    const token = this.jwtService.sign(
      {
        sub: target.id,
        email: target.email,
        role: target.role,
        name: target.name,
        imp: { by: rootBy, byName: rootName, byRole: rootRole },
      },
      { expiresIn: '1d' },
    );

    const { password: _p, ...user } = target;
    return { token, user, impersonating: true, actingAs: target.name };
  }

  /** Return to the original operator's account. */
  async stopImpersonation(actor: any) {
    const backTo = actor?.imp?.by;
    if (!backTo) throw new UnauthorizedException('Not currently switched into another account');

    const user = await this.prisma.user.findUnique({ where: { id: backTo } });
    if (!user) throw new UnauthorizedException('Original account not found');

    const token = this.jwtService.sign(
      { sub: user.id, email: user.email, role: user.role, name: user.name },
      { expiresIn: '7d' },
    );
    const { password: _p, ...safe } = user;
    return { token, user: safe, impersonating: false };
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
        parentId: true,
        canTopupDownline: true,
        canSetPackagePrice: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return user;
  }
}