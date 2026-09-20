import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Inject } from '@nestjs/common';
import { createHash, randomInt, randomBytes } from 'crypto';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { SmsService } from './sms.service';
import { IsString, Length, Matches } from 'class-validator';
import { ETHIOPIA_E164 } from './dto/register.dto';
import { treatAsProductionRuntime } from '../../config/public-api-host';

export class RequestOtpDto {
  @Matches(ETHIOPIA_E164, {
    message: 'phoneNumber must be +251 followed by 9 digits',
  })
  phoneNumber!: string;
}

export class VerifyOtpDto {
  @Matches(ETHIOPIA_E164, {
    message: 'phoneNumber must be +251 followed by 9 digits',
  })
  phoneNumber!: string;

  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/)
  code!: string;
}

const OTP_PREFIX = 'otp:phone:';
const OTP_SESSION_PREFIX = 'otp:session:';
const OTP_COOLDOWN_PREFIX = 'otp:cooldown:';
const OTP_REQUEST_PREFIX = 'otp:req:';
const OTP_TTL_SEC = 300;
const SESSION_TTL_SEC = 600;
/** Minimum gap between OTP sends to the same phone. */
const RESEND_COOLDOWN_SEC = 30;
/** Max OTP requests per phone per hour (abuse shield). */
const PHONE_REQUEST_LIMIT = 5;
const PHONE_REQUEST_WINDOW_SEC = 3600;

/**
 * Phone OTP for signup/login step-up. Codes are stored hashed in Redis.
 * Debug codes and the universal sandbox OTP are allowed only on local
 * development/test — never when PUBLIC_API_BASE_URL is the live Hebir host,
 * even if NODE_ENV was mis-set to development.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly sms: SmsService,
  ) {}

  async request(phoneNumber: string) {
    const smsConfigured = Boolean(
      this.config.get<string>('SMS_PROVIDER')?.trim(),
    );
    const debug = this.allowDebugOtp();

    if (!smsConfigured && !debug) {
      throw new ServiceUnavailableException(
        'Phone sign-in is temporarily unavailable. Try again later.',
      );
    }

    await this.enforceResendCooldown(phoneNumber);
    await this.enforcePhoneRequestLimit(phoneNumber);

    const code = debug ? '123456' : String(randomInt(100000, 999999));
    const otpKey = `${OTP_PREFIX}${phoneNumber}`;
    const hash = this.hash(phoneNumber, code);
    await this.redis.setex(otpKey, OTP_TTL_SEC, hash);

    if (debug) {
      this.logger.log(`[DEV OTP] Phone: ${phoneNumber} (code omitted in prod)`);
      return { sent: true, expiresInSec: OTP_TTL_SEC, debugCode: code };
    }

    // Do not block the HTTP handler on a slow SMS gateway.
    void this.deliverSmsAsync(phoneNumber, code, otpKey);
    return { sent: true, expiresInSec: OTP_TTL_SEC };
  }

  /** Validates and burns a one-time SMS code. */
  async consumeCode(phoneNumber: string, code: string) {
    const key = `${OTP_PREFIX}${phoneNumber}`;
    const failKey = `otp:fail:${phoneNumber}`;

    // Universal sandbox OTP only on local debug — never on the public API.
    if (this.allowDebugOtp() && code === '123456') {
      await this.redis.del(key);
      await this.redis.del(failKey);
      return;
    }

    const expected = await this.redis.get(key);
    if (!expected || expected !== this.hash(phoneNumber, code)) {
      const fails = await this.redis.incr(failKey);
      if (fails === 1) await this.redis.expire(failKey, OTP_TTL_SEC);
      if (fails >= 5) {
        await this.redis.del(key);
        throw new UnauthorizedException(
          'Too many incorrect codes. Request a new OTP.',
        );
      }
      throw new UnauthorizedException('Invalid or expired OTP');
    }
    await this.redis.del(key);
    await this.redis.del(failKey);
  }

  async verify(phoneNumber: string, code: string) {
    await this.consumeCode(phoneNumber, code);

    const sessionToken = randomBytes(32).toString('hex');
    await this.redis.setex(
      `${OTP_SESSION_PREFIX}${sessionToken}`,
      SESSION_TTL_SEC,
      phoneNumber,
    );
    return {
      verified: true,
      otpSessionToken: sessionToken,
      expiresInSec: SESSION_TTL_SEC,
    };
  }

  /** Consumes a one-time OTP session (e.g. before register). */
  async consumeSession(token: string | undefined, phoneNumber: string) {
    if (!token) {
      throw new BadRequestException('otpSessionToken is required');
    }
    const key = `${OTP_SESSION_PREFIX}${token}`;
    const stored = await this.redis.get(key);
    if (!stored || stored !== phoneNumber) {
      throw new UnauthorizedException('OTP session invalid or expired');
    }
    await this.redis.del(key);
  }

  private async enforceResendCooldown(phoneNumber: string) {
    const key = `${OTP_COOLDOWN_PREFIX}${phoneNumber}`;
    const ttl = await this.redis.ttl(key);
    if (ttl > 0) {
      throw new HttpException(
        `Please wait ${ttl} seconds before requesting another code`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async enforcePhoneRequestLimit(phoneNumber: string) {
    const key = `${OTP_REQUEST_PREFIX}${phoneNumber}`;
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, PHONE_REQUEST_WINDOW_SEC);
    }
    if (count > PHONE_REQUEST_LIMIT) {
      throw new HttpException(
        'Too many OTP requests for this phone number. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async deliverSmsAsync(
    phoneNumber: string,
    code: string,
    otpKey: string,
  ) {
    try {
      await this.sms.sendOtp(phoneNumber, code);
      await this.redis.setex(
        `${OTP_COOLDOWN_PREFIX}${phoneNumber}`,
        RESEND_COOLDOWN_SEC,
        '1',
      );
    } catch (err) {
      await this.redis.del(otpKey);
      this.logger.error(
        `OTP SMS delivery failed for ${phoneNumber}: ${(err as Error).message}`,
      );
    }
  }

  private allowDebugOtp(): boolean {
    if (
      treatAsProductionRuntime(
        this.config.get<string>('NODE_ENV'),
        this.config.get<string>('PUBLIC_API_BASE_URL'),
      )
    ) {
      return false;
    }
    const nodeEnv = this.config.get<string>('NODE_ENV');
    return nodeEnv === 'development' || nodeEnv === 'test';
  }

  private hash(phoneNumber: string, code: string) {
    const pepper =
      this.config.get<string>('JWT_ACCESS_SECRET') ?? 'otp-dev-pepper';
    return createHash('sha256')
      .update(`${pepper}:${phoneNumber}:${code}`)
      .digest('hex');
  }
}
