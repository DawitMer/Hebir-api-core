import {
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

export class UpdateLocationDto {
  @IsNumber()
  @IsLatitude()
  lat: number;

  @IsNumber()
  @IsLongitude()
  lng: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(360)
  heading?: number;

  /** m/s — anything above this is a bad GPS fix, not a vehicle. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(120)
  speed?: number;
}
