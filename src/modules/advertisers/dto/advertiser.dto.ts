import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class AdvertiserRegisterDto {
  @IsString() @MinLength(2) @MaxLength(120) companyName: string;
  @IsString() @MinLength(2) @MaxLength(120) contactName: string;
  @IsEmail() @MaxLength(160) email: string;
  @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @IsOptional()
  @IsString()
  @Matches(/^\d{10}$/, { message: 'TIN must be 10 digits' })
  tinNumber?: string;
  @IsOptional() @IsUrl({ protocols: ['https', 'http'] }) website?: string;
  /** ≥10 chars; the site enforces a mix, the server enforces length. */
  @IsString() @MinLength(10) @MaxLength(128) password: string;
}

export class AdvertiserLoginDto {
  @IsEmail() @MaxLength(160) email: string;
  @IsString() @MinLength(1) @MaxLength(128) password: string;
}

export class AdvertiserCampaignDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) sponsorName?: string;
  @IsString() @MinLength(2) @MaxLength(160) title: string;
  @IsString() @MinLength(10) @MaxLength(600) message: string;
  /** Image or short video (https). Reviewed by ops before going live. */
  @IsOptional() @IsUrl({ protocols: ['https'] }) assetUrl?: string;
  @IsOptional() @IsString() @MaxLength(80) ctaLabel?: string;
  @IsOptional() @IsUrl({ protocols: ['https'] }) ctaUrl?: string;
  @IsArray() @ArrayMaxSize(8) @IsString({ each: true }) ageBands: string[];
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  workCategories: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  interests?: string[];
  @IsISO8601() startsAt: string;
  @IsISO8601() endsAt: string;
  @IsInt() @Min(5) @Max(60) requiredViewSeconds: number;
  /** Verified views to buy; price = views × pricePerViewMinor. */
  @IsInt() @Min(1) views: number;
}

export class AdvertiserCampaignUpdateDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) sponsorName?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(160) title?: string;
  @IsOptional() @IsString() @MinLength(10) @MaxLength(600) message?: string;
  @IsOptional() @IsUrl({ protocols: ['https'] }) assetUrl?: string;
  @IsOptional() @IsString() @MaxLength(80) ctaLabel?: string;
  @IsOptional() @IsUrl({ protocols: ['https'] }) ctaUrl?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  ageBands?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  workCategories?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  interests?: string[];
  @IsOptional() @IsISO8601() startsAt?: string;
  @IsOptional() @IsISO8601() endsAt?: string;
  @IsOptional() @IsInt() @Min(5) @Max(60) requiredViewSeconds?: number;
  @IsOptional() @IsInt() @Min(1) views?: number;
}
