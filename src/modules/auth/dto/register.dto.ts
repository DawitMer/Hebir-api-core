import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { UserRole } from '../entities/user-account.entity';

/** Ethiopia E.164: +251 + 9 digits (demo-friendly; libphonenumber ET is too strict). */
export const ETHIOPIA_E164 = /^\+251\d{9}$/;

/**
 * Roles a caller may ask for on public signup. `admin` and `gov_officer` are
 * privileged and must be provisioned out of band (seed / operator action) —
 * accepting them here would let anyone grant themselves staff access.
 */
export const SELF_SERVICE_ROLES: UserRole[] = [UserRole.RIDER, UserRole.DRIVER];

export class RegisterDto {
  @Matches(ETHIOPIA_E164, {
    message: 'phoneNumber must be +251 followed by 9 digits',
  })
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
