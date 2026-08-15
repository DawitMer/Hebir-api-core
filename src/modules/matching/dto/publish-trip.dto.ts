import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsNumber,
  IsObject,
  Min,
  ValidateNested,
} from 'class-validator';

class GeoPointDto {
  @IsNumber()
  lat: number;

  @IsNumber()
  lng: number;
}

export class PublishTripDto {
  @IsObject()
  @ValidateNested()
  @Type(() => GeoPointDto)
  startPoint: GeoPointDto;

  @IsObject()
  @ValidateNested()
  @Type(() => GeoPointDto)
  destination: GeoPointDto;

  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => GeoPointDto)
  routePath: GeoPointDto[];

  @IsDateString()
  departureTime: string;

  @IsInt()
  @Min(1)
  totalSeats: number;

  @IsNumber()
  @Min(0)
  pricePerSeat: number;
}
