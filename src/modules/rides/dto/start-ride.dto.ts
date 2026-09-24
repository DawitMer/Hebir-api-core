import { IsString, Length, Matches } from 'class-validator';

export class StartRideDto {
  /** Privacy code shown on the rider app (registered) or SMS (guest). */
  @IsString()
  @Length(4, 6)
  @Matches(/^\d{4,6}$/)
  startCode!: string;
}
