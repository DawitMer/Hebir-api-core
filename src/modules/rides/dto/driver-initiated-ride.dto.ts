import { Type } from 'class-transformer';
import {
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ETHIOPIA_E164 } from '../../auth/dto/register.dto';
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
  @Matches(ETHIOPIA_E164, {
    message: 'riderPhoneNumber must be +251 followed by 9 digits',
  })
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
