import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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

/** Vehicle classes dispatch understands; anything else is not offerable. */
export const RIDE_VEHICLE_TYPES = [
  'any',
  'sedan',
  'suv',
  'xl',
  'minivan',
  'motorbike',
  'moto',
] as const;

class GeoPointDto {
  @IsNumber()
  @IsLatitude()
  lat: number;

  @IsNumber()
  @IsLongitude()
  lng: number;
}

class RideWaypointDto {
  @IsNumber()
  @IsLatitude()
  lat: number;

  @IsNumber()
  @IsLongitude()
  lng: number;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  address?: string;

  @IsOptional()
  @IsNumber()
  sequence?: number;
}

export class RequestRideDto {
  @IsObject()
  @ValidateNested()
  @Type(() => GeoPointDto)
  pickup: GeoPointDto;

  @IsObject()
  @ValidateNested()
  @Type(() => GeoPointDto)
  dropoff: GeoPointDto;

  /** Intermediate stops (pickup → stops → dropoff). Max 3. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => RideWaypointDto)
  waypoints?: RideWaypointDto[];

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

  /** Road distance the rider was quoted on (OSRM through stops). Preferred over haversine. */
  @IsOptional()
  @IsNumber()
  distanceKm?: number;

  /** Trip duration the rider was quoted on (minutes). */
  @IsOptional()
  @IsNumber()
  durationMinutes?: number;
}
