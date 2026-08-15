import { IsInt, IsUUID, Min } from 'class-validator';

export class SelectMatchDto {
  @IsUUID()
  tripId: string;

  @IsUUID()
  riderRequestId: string;

  @IsInt()
  @Min(1)
  seats: number;
}
