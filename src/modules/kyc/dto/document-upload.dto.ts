import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { DocumentCategory } from '../entities/document-submission.entity';

const DOC_TYPES = [
  'license',
  'national_id',
  'registration',
  'insurance',
  'selfie',
] as const;

export class PresignDocumentDto {
  @IsIn(DOC_TYPES)
  documentType: (typeof DOC_TYPES)[number];

  @IsIn([DocumentCategory.DRIVER, DocumentCategory.VEHICLE])
  category: DocumentCategory;

  @IsString()
  @Matches(/^image\/(jpeg|jpg|png|webp)$|^application\/pdf$/)
  contentType: string;
}

export class ConfirmDocumentDto {
  @IsString()
  @MaxLength(512)
  storageKey: string;

  @IsIn(DOC_TYPES)
  documentType: (typeof DOC_TYPES)[number];

  @IsIn([DocumentCategory.DRIVER, DocumentCategory.VEHICLE])
  category: DocumentCategory;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}

export class StartVerificationDto {
  @IsString()
  @MaxLength(64)
  licenseNumber: string;

  @IsString()
  @MaxLength(64)
  region: string;

  @IsString()
  @MaxLength(64)
  vehicleType: string;

  @IsOptional()
  @IsInt()
  @Min(1990)
  vehicleYear?: number;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  vehicleColor?: string;
}

/** Replacement car. The live vehicles row stays until ops approves. */
export class VehicleChangeDto {
  @IsString()
  @MaxLength(40)
  make: string;

  @IsString()
  @MaxLength(40)
  model: string;

  @IsString()
  @MaxLength(24)
  plate: string;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  color?: string;

  @IsOptional()
  @IsInt()
  @Min(1990)
  year?: number;
}
