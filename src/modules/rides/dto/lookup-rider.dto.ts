import { Type } from 'class-transformer';
import {
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsObject,
  ValidateNested,
} from 'class-validator';
import { IsEthiopiaPhone } from '../../../common/phone/ethiopia-phone';

class DriverLocationDto {
  @IsNumber()
  @IsLatitude()
  lat!: number;

  @IsNumber()
  @IsLongitude()
  lng!: number;
}

export class LookupRiderDto {
  @IsEthiopiaPhone()
  phoneNumber!: string;

  /** Driver GPS — street-hail only works within 300 m of the rider. */
  @IsObject()
  @ValidateNested()
  @Type(() => DriverLocationDto)
  driverLocation!: DriverLocationDto;
}
