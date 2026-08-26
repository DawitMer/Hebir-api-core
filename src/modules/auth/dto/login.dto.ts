import { IsString } from 'class-validator';
import { IsEthiopiaPhone } from '../../../common/phone/ethiopia-phone';

export class LoginDto {
  @IsEthiopiaPhone()
  phoneNumber: string;

  @IsString()
  password: string;
}
