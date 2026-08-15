import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';

export enum ReviewDecision {
  APPROVE = 'approve',
  REJECT = 'reject',
  ESCALATE = 'escalate',
}

export class ReviewDecisionDto {
  @IsEnum(ReviewDecision)
  decision: ReviewDecision;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsUUID()
  escalateToId?: string;
}
