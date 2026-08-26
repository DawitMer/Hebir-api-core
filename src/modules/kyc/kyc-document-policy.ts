import { DocumentReviewStatus } from './entities/document-submission.entity';

/** License, libre, and insurance must store an expiry — same as Uber/Lyft cards. */
export const DOCUMENT_TYPES_REQUIRING_EXPIRY = [
  'license',
  'registration',
  'insurance',
] as const;

export function documentRequiresExpiry(documentType: string): boolean {
  return (DOCUMENT_TYPES_REQUIRING_EXPIRY as readonly string[]).includes(
    documentType,
  );
}

export function isKycDocumentExpired(
  expiresAt: Date | string | null | undefined,
  now = Date.now(),
): boolean {
  if (!expiresAt) return false;
  const ms =
    expiresAt instanceof Date
      ? expiresAt.getTime()
      : new Date(expiresAt).getTime();
  return Number.isFinite(ms) && ms < now;
}

/**
 * Uber/Lyft: an approved file cannot be swapped. The stored dates stay until
 * the document expires or ops asks for a resubmission.
 */
export function isApprovedKycDocumentLocked(
  doc: {
    status: DocumentReviewStatus;
    expiresAt: Date | string | null;
  },
  now = Date.now(),
): boolean {
  if (doc.status !== DocumentReviewStatus.APPROVED) return false;
  return !isKycDocumentExpired(doc.expiresAt, now);
}
