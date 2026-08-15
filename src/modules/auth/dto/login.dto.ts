import { IsString, Matches } from 'class-validator';
import { ETHIOPIA_E164 } from './register.dto';

export class LoginDto {
  @Matches(ETHIOPIA_E164, {
    message: 'phoneNumber must be +251 followed by 9 digits',
  })
  phoneNumber: string;

  @IsString()
  password: string;
}
