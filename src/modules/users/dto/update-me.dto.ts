import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  username?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  savedPlaces?: Array<Record<string, unknown>>;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  vehicleMake?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  vehicleModel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  vehiclePlate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  vehicleColor?: string;

  @IsOptional()
  @IsInt()
  vehicleYear?: number;

  @IsOptional()
  @IsInt()
  vehicleCapacity?: number;
}
