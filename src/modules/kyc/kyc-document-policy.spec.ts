import { DocumentReviewStatus } from './entities/document-submission.entity';
import {
  documentRequiresExpiry,
  isApprovedKycDocumentLocked,
  isKycDocumentExpired,
} from './kyc-document-policy';

describe('KYC document policy', () => {
  const now = Date.UTC(2026, 7, 20);

  it('requires expiry on license, registration, and insurance', () => {
    expect(documentRequiresExpiry('license')).toBe(true);
    expect(documentRequiresExpiry('registration')).toBe(true);
    expect(documentRequiresExpiry('insurance')).toBe(true);
    expect(documentRequiresExpiry('selfie')).toBe(false);
    expect(documentRequiresExpiry('national_id')).toBe(false);
  });

  it('treats a past expiresAt as expired', () => {
    expect(isKycDocumentExpired(new Date(now - 1), now)).toBe(true);
    expect(isKycDocumentExpired(new Date(now + 1), now)).toBe(false);
    expect(isKycDocumentExpired(null, now)).toBe(false);
  });

  it('locks approved documents that have not expired', () => {
    expect(
      isApprovedKycDocumentLocked(
        {
          status: DocumentReviewStatus.APPROVED,
          expiresAt: new Date(now + 86_400_000),
        },
        now,
      ),
    ).toBe(true);
    expect(
      isApprovedKycDocumentLocked(
        {
          status: DocumentReviewStatus.APPROVED,
          expiresAt: null,
        },
        now,
      ),
    ).toBe(true);
  });

  it('allows replace after expiry, rejection, or while still in queue', () => {
    expect(
      isApprovedKycDocumentLocked(
        {
          status: DocumentReviewStatus.APPROVED,
          expiresAt: new Date(now - 1),
        },
        now,
      ),
    ).toBe(false);
    expect(
      isApprovedKycDocumentLocked({
        status: DocumentReviewStatus.QUEUED,
        expiresAt: null,
      }),
    ).toBe(false);
    expect(
      isApprovedKycDocumentLocked({
        status: DocumentReviewStatus.REJECTED,
        expiresAt: null,
      }),
    ).toBe(false);
  });
});
