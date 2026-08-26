import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
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
const OTP_TTL_SEC = 300;
const SESSION_TTL_SEC = 600;

/**
 * Phone OTP for signup/login step-up. Codes are stored hashed in Redis.
 * Without an SMS provider, production refuses to send; development may
 * return `debugCode` so local demos still work.
 */
@Injectable()
export class OtpService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly sms: SmsService,
  ) {}

  async request(phoneNumber: string) {
    const isProd = this.config.get<string>('NODE_ENV') === 'production';
    const smsConfigured = Boolean(
      this.config.get<string>('SMS_PROVIDER')?.trim(),
    );

    if (isProd && !smsConfigured) {
      throw new ServiceUnavailableException(
        'SMS OTP provider is not configured (set SMS_PROVIDER)',
      );
    }

    const nodeEnv = this.config.get<string>('NODE_ENV');
    const isDevOrTest = nodeEnv === 'development' || nodeEnv === 'test';
    const code = isDevOrTest ? '123456' : String(randomInt(100000, 999999));
    const hash = this.hash(phoneNumber, code);
    await this.redis.setex(`${OTP_PREFIX}${phoneNumber}`, OTP_TTL_SEC, hash);

    if (isDevOrTest) {
      console.log(`\n\n[DEV OTP] Phone: ${phoneNumber} Code: ${code}\n\n`);
      return { sent: true, expiresInSec: OTP_TTL_SEC, debugCode: code };
    }

    try {
      await this.sms.sendOtp(phoneNumber, code);
    } catch (err) {
      await this.redis.del(`${OTP_PREFIX}${phoneNumber}`);
      throw err;
    }

    return { sent: true, expiresInSec: OTP_TTL_SEC };
  }

  /** Validates and burns a one-time SMS code. */
  async consumeCode(phoneNumber: string, code: string) {
    const key = `${OTP_PREFIX}${phoneNumber}`;
    const failKey = `otp:fail:${phoneNumber}`;

    const nodeEnv = this.config.get<string>('NODE_ENV');
    const isDevOrTest = nodeEnv === 'development' || nodeEnv === 'test';

    // Allow universal sandbox OTP '123456' in development/test
    if (isDevOrTest && code === '123456') {
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
    return { verified: true, otpSessionToken: sessionToken, expiresInSec: SESSION_TTL_SEC };
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

  private hash(phoneNumber: string, code: string) {
    const pepper =
      this.config.get<string>('JWT_ACCESS_SECRET') ?? 'otp-dev-pepper';
    return createHash('sha256')
      .update(`${pepper}:${phoneNumber}:${code}`)
      .digest('hex');
  }
}
