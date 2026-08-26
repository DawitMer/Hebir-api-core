import { Type } from 'class-transformer';
import {
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { IsEthiopiaPhone } from '../../../common/phone/ethiopia-phone';
import { RIDE_VEHICLE_TYPES } from './request-ride.dto';

class GeoPointDto {
  @IsNumber()
  @IsLatitude()
  lat!: number;

  @IsNumber()
  @IsLongitude()
  lng!: number;
}

/** Street-hail / phone-join: driver creates an assigned ride for a rider. */
export class DriverInitiatedRideDto {
  @IsEthiopiaPhone(
    'riderPhoneNumber must be a valid Ethiopian mobile (+2519XXXXXXXX)',
  )
  riderPhoneNumber!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => GeoPointDto)
  pickup!: GeoPointDto;

  @IsObject()
  @ValidateNested()
  @Type(() => GeoPointDto)
  dropoff!: GeoPointDto;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  pickupAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  dropoffAddress?: string;

  @IsOptional()
  @IsIn([...RIDE_VEHICLE_TYPES])
  vehicleType?: string;

  @IsOptional()
  @IsNumber()
  distanceKm?: number;

  @IsOptional()
  @IsNumber()
  durationMinutes?: number;
}
