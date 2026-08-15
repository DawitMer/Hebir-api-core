import { IsNumber, IsString, Min } from 'class-validator';

export class CreateTipDto {
  @IsString()
  rideId: string;

  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsString()
  idempotencyKey: string;
}
