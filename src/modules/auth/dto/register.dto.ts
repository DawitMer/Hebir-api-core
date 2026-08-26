import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { UserRole } from '../entities/user-account.entity';
import {
  ETHIOPIA_E164,
  IsEthiopiaPhone,
} from '../../../common/phone/ethiopia-phone';

export { ETHIOPIA_E164 };

/**
 * Roles a caller may ask for on public signup. `admin` and `gov_officer` are
 * privileged and must be provisioned out of band (seed / operator action) —
 * accepting them here would let anyone grant themselves staff access.
 */
export const SELF_SERVICE_ROLES: UserRole[] = [UserRole.RIDER, UserRole.DRIVER];

export class RegisterDto {
  @IsEthiopiaPhone()
  phoneNumber: string;

  /** Optional — rider/driver are passwordless (OTP). Staff are seeded with a hash. */
  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  fullName?: string;

  /** Opaque token from POST /auth/otp/verify — required when AUTH_REQUIRE_OTP=true. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  otpSessionToken?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(2)
  @IsIn(SELF_SERVICE_ROLES, { each: true })
  roles: UserRole[];
}
