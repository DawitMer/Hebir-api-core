import { IsString, Length, Matches } from 'class-validator';

export class StartRideDto {
  /** 4-digit privacy code shown only on the rider's phone. */
  @IsString()
  @Length(4, 4)
  @Matches(/^\d{4}$/)
  startCode!: string;
}
