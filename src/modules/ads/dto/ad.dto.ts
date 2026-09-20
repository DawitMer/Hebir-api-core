import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CampaignState } from '../entities/ad-rewards.entity';

export class RiderAdProfileDto {
  @IsString() @MaxLength(16) ageBand: string;
  @IsString() @MaxLength(32) workCategory: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  interests?: string[];
  @IsOptional() @IsString() @MaxLength(48) area?: string;
  @IsBoolean() consented: boolean;
  @IsOptional() @IsString() @MaxLength(32) consentVersion?: string;
}

export class HeartbeatDto {
  @IsString() token: string;
  @IsInt() @Min(1) sequence: number;
  @IsInt() @Min(0) @Max(30) visibleSeconds: number;
  @IsOptional() @IsBoolean() videoPlaying?: boolean;
}

export class CompleteSessionDto {
  @IsString() token: string;
}

export class CashoutDto {
  @IsInt() @Min(1) amountMinor: number;
}

/** Ops-authored (house) campaign. */
export class CampaignDto {
  @IsString() @MinLength(2) @MaxLength(120) sponsorName: string;
  @IsString() @MinLength(2) @MaxLength(160) title: string;
  @IsString() @MinLength(2) @MaxLength(600) message: string;
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_tld: false })
  assetUrl?: string;
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_tld: false })
  ctaUrl?: string;
  @IsOptional() @IsString() @MaxLength(80) ctaLabel?: string;
  @IsArray() @IsString({ each: true }) ageBands: string[];
  @IsArray() @IsString({ each: true }) workCategories: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) interests?: string[];
  @IsOptional() @IsEnum(CampaignState) state?: CampaignState;
  @IsString() startsAt: string;
  @IsString() endsAt: string;
  @IsInt() @Min(5) @Max(60) requiredViewSeconds: number;
  @IsOptional() @IsInt() @Min(300) rewardMinor?: number;
  @IsInt() @Min(0) budgetMinor: number;
  @IsInt() @Min(1) @Max(1000) deliveryWeight: number;
}

export class CampaignReviewDto {
  @IsIn(['approve', 'reject']) decision: 'approve' | 'reject';
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
