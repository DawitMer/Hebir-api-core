import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsNumber, IsObject, Min, ValidateNested } from 'class-validator';

class GeoPointDto {
  @IsNumber()
  lat: number;

  @IsNumber()
  lng: number;
}

export class SubmitRiderRequestDto {
  @IsObject()
  @ValidateNested()
  @Type(() => GeoPointDto)
  pickup: GeoPointDto;

  @IsObject()
  @ValidateNested()
  @Type(() => GeoPointDto)
  dropoff: GeoPointDto;

  @IsDateString()
  earliestDeparture: string;

  @IsDateString()
  latestDeparture: string;

  @IsInt()
  @Min(1)
  seatsNeeded: number;

  @IsNumber()
  @Min(0)
  priceCeiling: number;
}
