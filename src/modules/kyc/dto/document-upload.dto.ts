import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
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
  @IsString()
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
}
