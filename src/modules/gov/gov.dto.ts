import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const EXPENSE_REVIEW_STATUSES = [
  'pending',
  'verified',
  'flagged',
  'rejected',
  'approved',
  'changes_required',
  'under_review',
  'submitted',
] as const;

export class ReviewExpenseDto {
  @IsIn(EXPENSE_REVIEW_STATUSES)
  status: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewerNotes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class GovLimitDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

export class GovExpensesQueryDto extends GovLimitDto {
  @IsOptional()
  @IsIn([...EXPENSE_REVIEW_STATUSES, 'draft', 'all', 'not_submitted'])
  status?: string;

  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

export class GovDriverSearchDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  tin?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}
