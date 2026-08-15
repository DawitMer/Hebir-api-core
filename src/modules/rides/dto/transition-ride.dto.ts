import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { RideStatus } from '../entities/ride.entity';

export class TransitionRideDto {
  @IsEnum(RideStatus)
  status: RideStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
