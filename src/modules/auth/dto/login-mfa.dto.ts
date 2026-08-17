import { IsString, Length, Matches } from 'class-validator';

export class LoginMfaDto {
  @IsString()
  @Length(16, 128)
  mfaToken: string;

  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/)
  code: string;
}
