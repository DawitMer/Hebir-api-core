import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { UserRole } from '../entities/user-account.entity';
import { ETHIOPIA_E164, SELF_SERVICE_ROLES } from './register.dto';

/** Phone + OTP code → session tokens (passwordless rider/driver auth). */
export class OtpLoginDto {
  @Matches(ETHIOPIA_E164, {
    message: 'phoneNumber must be +251 followed by 9 digits',
  })
  phoneNumber!: string;

  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/)
  code!: string;

  /** Used only when creating a new account. Ignored if the phone already exists. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @IsIn(SELF_SERVICE_ROLES, { each: true })
  roles?: UserRole[];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  fullName?: string;
}
