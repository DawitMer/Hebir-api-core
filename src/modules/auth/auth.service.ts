import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash, randomBytes, randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import {
  AccountStanding,
  isAccountClosed,
  UserAccount,
  UserRole,
} from './entities/user-account.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { RegisterDto, SELF_SERVICE_ROLES } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { LoginMfaDto } from './dto/login-mfa.dto';
import { OtpLoginDto } from './dto/otp-login.dto';
import { OtpService } from './otp.service';
import { FirebaseLoginDto } from './dto/firebase-login.dto';
import { FirebaseService } from './firebase/firebase.service';
import { normalizePhoneNumber } from './utils/phone-normalization.util';

const SALT_ROUNDS = 10;
const ACCESS_DENY_PREFIX = 'jwt:deny:';
const STAFF_MFA_PREFIX = 'staff:mfa:';
const STAFF_MFA_TTL_SEC = 300;

/** Roles/standing are re-read from Postgres at most this often per user. */
const AUTH_CONTEXT_TTL_MS = 15_000;
const AUTH_CONTEXT_MAX_ENTRIES = 50_000;

@Injectable()
export class AuthService {
  private readonly authContextCache = new Map<
    string,
    {
      value: { roles: UserRole[]; standing: AccountStanding } | null;
      expiresAt: number;
    }
  >();

  constructor(
    @InjectRepository(UserAccount)
    private readonly users: Repository<UserAccount>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly otp: OtpService,
    private readonly firebase: FirebaseService,
  ) {}

  async register(dto: RegisterDto) {
    const requireOtp =
      this.config.get<string>('AUTH_REQUIRE_OTP') === 'true' ||
      this.config.get<string>('NODE_ENV') === 'production' ||
      !dto.password;
    if (requireOtp) {
      await this.otp.consumeSession(dto.otpSessionToken, dto.phoneNumber);
    }

    const existing = await this.users.findOne({
      where: { phoneNumber: dto.phoneNumber },
    });
    if (existing) {
      throw new ConflictException('Phone number already registered');
    }

    const passwordHash = dto.password
      ? await bcrypt.hash(dto.password, SALT_ROUNDS)
      : null;
    // Re-filter server-side: the DTO validates the request, this guarantees no
    // privileged role can ever be persisted from a signup payload.
    const roles = dto.roles.filter((role) => SELF_SERVICE_ROLES.includes(role));
    const user = await this.users.save(
      this.users.create({
        phoneNumber: dto.phoneNumber,
        fullName: dto.fullName,
        passwordHash,
        roles: roles.length > 0 ? roles : [UserRole.RIDER],
      }),
    );

    return this.issueTokenPair(user);
  }

  /**
   * Passwordless sign-in for rider & driver apps via Firebase Phone Authentication.
   *
   * Verifies the cryptographic Firebase ID token, extracts the verified phone number,
   * links existing accounts or creates a new user account, and issues a standard Hebir JWT token pair.
   */
  async loginWithFirebase(dto: FirebaseLoginDto) {
    const verified = await this.firebase.verifyIdToken(dto.firebaseIdToken);
    const normalizedPhone = normalizePhoneNumber(verified.phoneNumber);

    // Look up by firebaseUid first, or fallback to normalized phone number
    let user = await this.users.findOne({
      where: [{ firebaseUid: verified.uid }, { phoneNumber: normalizedPhone }],
    });

    if (user) {
      let needsSave = false;
      if (!user.firebaseUid) {
        user.firebaseUid = verified.uid;
        needsSave = true;
      }
      if (!user.phoneVerifiedAt) {
        user.phoneVerifiedAt = new Date();
        needsSave = true;
      }
      if (!user.fullName && dto.fullName) {
        user.fullName = dto.fullName;
        needsSave = true;
      }
      if (needsSave) {
        user = await this.users.save(user);
      }
    } else {
      const roles = (dto.roles ?? [UserRole.RIDER]).filter((role) =>
        SELF_SERVICE_ROLES.includes(role),
      );
      user = await this.users.save(
        this.users.create({
          phoneNumber: normalizedPhone,
          firebaseUid: verified.uid,
          phoneVerifiedAt: new Date(),
          fullName: dto.fullName ?? null,
          passwordHash: null,
          roles: roles.length > 0 ? roles : [UserRole.RIDER],
          standing: AccountStanding.GOOD,
        }),
      );
    }

    if (isAccountClosed(user.standing)) {
      throw new ForbiddenException('This account is not available');
    }

    // Invalidate local context cache so fresh roles and standing are applied
    this.authContextCache.delete(user.id);

    return this.issueTokenPair(user);
  }

  /**
   * Passwordless sign-in for rider/driver apps. Verifies SMS OTP, then finds
   * or creates the account with a null passwordHash.
   */
  async loginWithOtp(dto: OtpLoginDto) {
    await this.otp.consumeCode(dto.phoneNumber, dto.code);

    const normalizedPhone = normalizePhoneNumber(dto.phoneNumber);
    let user = await this.users.findOne({
      where: { phoneNumber: normalizedPhone },
    });

    if (!user) {
      const roles = (dto.roles ?? [UserRole.RIDER]).filter((role) =>
        SELF_SERVICE_ROLES.includes(role),
      );
      user = await this.users.save(
        this.users.create({
          phoneNumber: normalizedPhone,
          fullName: dto.fullName,
          passwordHash: null,
          roles: roles.length > 0 ? roles : [UserRole.RIDER],
        }),
      );
    }

    if (isAccountClosed(user.standing)) {
      throw new ForbiddenException('This account is not available');
    }

    return this.issueTokenPair(user);
  }

  async login(dto: LoginDto) {
    const user = await this.users
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.phoneNumber = :phoneNumber', {
        phoneNumber: dto.phoneNumber,
      })
      .getOne();

    if (!user?.passwordHash) {
      throw new UnauthorizedException(
        'This account uses phone OTP — password login is not available',
      );
    }
    if (!(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (isAccountClosed(user.standing)) {
      throw new ForbiddenException('This account is not available');
    }

    const mfaToken = randomBytes(32).toString('hex');
    await this.redis.set(
      `${STAFF_MFA_PREFIX}${mfaToken}`,
      user.id,
      'EX',
      STAFF_MFA_TTL_SEC,
    );
    return {
      mfaRequired: true as const,
      mfaToken,
      phoneNumber: user.phoneNumber,
      user: {
        id: user.id,
        phoneNumber: user.phoneNumber,
        fullName: user.fullName,
        username: user.username,
        roles: user.roles,
      },
    };
  }

  /**
   * Second factor for staff password login. JWTs are issued only after the
   * SMS code bound to this challenge is consumed.
   */
  async loginWithMfa(dto: LoginMfaDto) {
    const key = `${STAFF_MFA_PREFIX}${dto.mfaToken}`;
    const userId = await this.redis.get(key);
    if (!userId) {
      throw new UnauthorizedException(
        'Verification session expired. Sign in again.',
      );
    }

    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) {
      await this.redis.del(key);
      throw new UnauthorizedException('Account not found');
    }

    await this.otp.consumeCode(user.phoneNumber, dto.code);
    await this.redis.del(key);

    if (isAccountClosed(user.standing)) {
      throw new ForbiddenException('This account is not available');
    }

    return this.issueTokenPair(user);
  }

  /**
   * Authoritative roles/standing for a bearer token. The JWT's own `roles`
   * claim is a snapshot from issue time, so a suspension or role removal
   * would otherwise stay ineffective until the access token expired.
   * Cached briefly because chatty clients (GPS pings) hit this per request.
   */
  async getAuthContext(
    userId: string,
  ): Promise<{ roles: UserRole[]; standing: AccountStanding } | null> {
    const cached = this.authContextCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, roles: true, standing: true },
    });
    const value = user ? { roles: user.roles, standing: user.standing } : null;
    this.authContextCache.set(userId, {
      value,
      expiresAt: Date.now() + AUTH_CONTEXT_TTL_MS,
    });
    if (this.authContextCache.size > AUTH_CONTEXT_MAX_ENTRIES) {
      this.authContextCache.clear();
    }
    return value;
  }

  /** Drop cached roles/standing so a ban or deletion takes effect immediately. */
  invalidateAuthContext(userId: string) {
    this.authContextCache.delete(userId);
  }

  /**
   * Rotate refresh token: validate opaque token, revoke it, issue a new pair.
   * Reuse of an already-rotated token revokes the entire user session family.
   */
  async refresh(rawRefreshToken: string) {
    const tokenHash = this.hashToken(rawRefreshToken);

    return this.refreshTokens.manager.transaction(async (em) => {
      const existing = await em
        .createQueryBuilder(RefreshToken, 'rt')
        .setLock('pessimistic_write')
        .where('rt.tokenHash = :tokenHash', { tokenHash })
        .getOne();

      if (!existing) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      if (existing.revokedAt) {
        await this.revokeAllForUser(existing.userId);
        throw new UnauthorizedException(
          'Refresh token reuse detected — sessions revoked',
        );
      }

      if (existing.expiresAt.getTime() <= Date.now()) {
        existing.revokedAt = new Date();
        await em.save(existing);
        throw new UnauthorizedException('Refresh token expired');
      }

      const user = await em.findOne(UserAccount, {
        where: { id: existing.userId },
      });
      if (!user) {
        throw new UnauthorizedException();
      }

      // Issue pair outside the locked row write path via repository helpers,
      // then mark the old token revoked under the same transaction.
      const pair = await this.issueTokenPair(user);
      existing.revokedAt = new Date();
      existing.replacedById = pair.refreshTokenId;
      await em.save(existing);

      return {
        accessToken: pair.accessToken,
        refreshToken: pair.refreshToken,
        user: pair.user,
      };
    });
  }

  /** Revoke one refresh session; optionally denylist current access `jti`. */
  async logout(rawRefreshToken: string | undefined, accessJti?: string) {
    if (rawRefreshToken) {
      const tokenHash = this.hashToken(rawRefreshToken);
      const existing = await this.refreshTokens.findOne({
        where: { tokenHash },
      });
      if (existing && !existing.revokedAt) {
        existing.revokedAt = new Date();
        await this.refreshTokens.save(existing);
      }
    }
    if (accessJti) {
      await this.denyAccessJti(accessJti);
    }
    return { ok: true };
  }

  /** Revoke every refresh token for the user and denylist current access token. */
  async logoutAll(userId: string, accessJti?: string) {
    await this.revokeAllForUser(userId);
    if (accessJti) {
      await this.denyAccessJti(accessJti);
    }
    return { ok: true };
  }

  async isAccessJtiDenied(jti: string | undefined): Promise<boolean> {
    if (!jti) return false;
    const hit = await this.redis.get(`${ACCESS_DENY_PREFIX}${jti}`);
    return hit === '1';
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeExpiredRefreshTokens() {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await this.refreshTokens.delete({
      expiresAt: LessThan(cutoff),
    });
  }

  private async issueTokenPair(user: UserAccount) {
    const jti = randomUUID();
    const payload = {
      sub: user.id,
      phoneNumber: user.phoneNumber,
      roles: user.roles,
      typ: 'access',
      jti,
    };

    const accessToken = this.jwt.sign(payload, {
      secret: this.config.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get<string>('JWT_ACCESS_EXPIRES_IN') as any,
    });

    const rawRefresh = randomBytes(48).toString('base64url');
    const tokenHash = this.hashToken(rawRefresh);
    const expiresAt = this.refreshExpiresAt();

    const row = await this.refreshTokens.save(
      this.refreshTokens.create({
        userId: user.id,
        tokenHash,
        expiresAt,
        revokedAt: null,
        replacedById: null,
      }),
    );

    return {
      accessToken,
      refreshToken: rawRefresh,
      refreshTokenId: row.id,
      user: {
        id: user.id,
        phoneNumber: user.phoneNumber,
        fullName: user.fullName,
        username: user.username,
        roles: user.roles,
      },
    };
  }

  private async revokeAllForUser(userId: string) {
    await this.refreshTokens
      .createQueryBuilder()
      .update(RefreshToken)
      .set({ revokedAt: new Date() })
      .where('"userId" = :userId', { userId })
      .andWhere('"revokedAt" IS NULL')
      .execute();
  }

  private async denyAccessJti(jti: string) {
    const ttlSec = this.accessTtlSeconds();
    await this.redis.set(
      `${ACCESS_DENY_PREFIX}${jti}`,
      '1',
      'EX',
      Math.max(ttlSec, 60),
    );
  }

  private hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  private refreshExpiresAt(): Date {
    const raw = this.config.get<string>('JWT_REFRESH_EXPIRES_IN') ?? '30d';
    return new Date(Date.now() + this.parseDurationMs(raw));
  }

  private accessTtlSeconds(): number {
    const raw = this.config.get<string>('JWT_ACCESS_EXPIRES_IN') ?? '15m';
    return Math.ceil(this.parseDurationMs(raw) / 1000);
  }

  private parseDurationMs(expiresIn: string): number {
    const m = /^(\d+)\s*([smhd])$/i.exec(expiresIn.trim());
    if (!m) return 30 * 24 * 60 * 60 * 1000;
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (unit === 's') return n * 1000;
    if (unit === 'm') return n * 60 * 1000;
    if (unit === 'h') return n * 60 * 60 * 1000;
    return n * 24 * 60 * 60 * 1000;
  }
}
