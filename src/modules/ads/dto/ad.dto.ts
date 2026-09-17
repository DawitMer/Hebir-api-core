import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUrl, Max, Min } from 'class-validator';
import { CampaignState } from '../entities/ad-rewards.entity';
export class RiderAdProfileDto { @IsString() ageBand: string; @IsString() workCategory: string; @IsBoolean() consented: boolean; @IsOptional() @IsString() consentVersion?: string; }
export class HeartbeatDto { @IsString() token: string; @IsInt() @Min(1) sequence: number; @IsInt() @Min(0) @Max(30) visibleSeconds: number; @IsOptional() @IsBoolean() videoPlaying?: boolean; }
export class CompleteSessionDto { @IsString() token: string; }
export class CashoutDto { @IsInt() @Min(1) amountMinor: number; }
export class CampaignDto { @IsString() sponsorName: string; @IsString() title: string; @IsString() message: string; @IsOptional() @IsUrl({ require_tld: false }) assetUrl?: string; @IsOptional() @IsUrl({ protocols: ['https'], require_tld: false }) ctaUrl?: string; @IsOptional() @IsString() ctaLabel?: string; @IsArray() ageBands: string[]; @IsArray() workCategories: string[]; @IsEnum(CampaignState) state: CampaignState; @IsString() startsAt: string; @IsString() endsAt: string; @IsInt() @Min(1) requiredViewSeconds: number; @IsInt() @Min(300) rewardMinor: number; @IsInt() @Min(0) budgetMinor: number; @IsInt() @Min(1) deliveryWeight: number; }
