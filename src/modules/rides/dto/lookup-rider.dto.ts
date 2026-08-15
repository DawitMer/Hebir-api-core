import { Type } from 'class-transformer';
import {
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsObject,
  Matches,
  ValidateNested,
} from 'class-validator';
import { ETHIOPIA_E164 } from '../../auth/dto/register.dto';

class DriverLocationDto {
  @IsNumber()
  @IsLatitude()
  lat!: number;

  @IsNumber()
  @IsLongitude()
  lng!: number;
}

export class LookupRiderDto {
  @Matches(ETHIOPIA_E164, {
    message: 'phoneNumber must be +251 followed by 9 digits',
  })
  phoneNumber!: string;

  /** Driver GPS — street-hail only works within 300 m of the rider. */
  @IsObject()
  @ValidateNested()
  @Type(() => DriverLocationDto)
  driverLocation!: DriverLocationDto;
}
