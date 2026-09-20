import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
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

export const GOV_LEGAL_TYPES = [
  'subpoena',
  'warrant',
  'court_order',
  'emergency',
] as const;

export const GOV_LEGAL_PRIORITIES = [
  'low',
  'medium',
  'high',
  'urgent',
] as const;

export const GOV_LEGAL_STATUSES = [
  'received',
  'in_review',
  'fulfilled',
  'rejected',
  'withdrawn',
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

  @IsOptional()
  @IsString()
  @MaxLength(64)
  before?: string;
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

export class CreateGovLegalRequestDto {
  @IsIn(GOV_LEGAL_TYPES)
  type: (typeof GOV_LEGAL_TYPES)[number];

  @IsString()
  @MaxLength(240)
  title: string;

  @IsString()
  @MaxLength(240)
  requestingAuthority: string;

  @IsString()
  @MaxLength(120)
  caseReference: string;

  @IsOptional()
  @IsUUID()
  driverId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  driverTin?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  dataScope: string[];

  @IsOptional()
  @IsIn(GOV_LEGAL_PRIORITIES)
  priority?: (typeof GOV_LEGAL_PRIORITIES)[number];

  @IsOptional()
  @IsISO8601()
  deadlineAt?: string;
}

export class UpdateGovLegalStatusDto {
  @IsIn(GOV_LEGAL_STATUSES)
  status: (typeof GOV_LEGAL_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  fulfilmentNotes?: string;
}

export class AssignGovLegalRequestDto {
  @IsUUID()
  officerId: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class CreateGovReportJobDto {
  @IsUUID()
  driverId: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  fiscalYear?: number;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  format?: string;

  @IsOptional()
  @IsUUID()
  legalRequestId?: string;
}
