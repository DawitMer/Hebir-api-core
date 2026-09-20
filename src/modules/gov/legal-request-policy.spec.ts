import {
  assertLegalStatusTransition,
  canAssignLegalRequest,
} from './legal-request-policy';
import { GovLegalRequestStatus } from './entities/gov-legal-request.entity';

describe('legal-request-policy', () => {
  it('allows received → in_review / rejected / withdrawn', () => {
    expect(() =>
      assertLegalStatusTransition(
        GovLegalRequestStatus.RECEIVED,
        GovLegalRequestStatus.IN_REVIEW,
      ),
    ).not.toThrow();
    expect(() =>
      assertLegalStatusTransition(
        GovLegalRequestStatus.RECEIVED,
        GovLegalRequestStatus.REJECTED,
      ),
    ).not.toThrow();
    expect(() =>
      assertLegalStatusTransition(
        GovLegalRequestStatus.RECEIVED,
        GovLegalRequestStatus.FULFILLED,
      ),
    ).toThrow(/Cannot move/);
  });

  it('allows in_review → fulfilled / rejected / withdrawn', () => {
    expect(() =>
      assertLegalStatusTransition(
        GovLegalRequestStatus.IN_REVIEW,
        GovLegalRequestStatus.FULFILLED,
      ),
    ).not.toThrow();
    expect(() =>
      assertLegalStatusTransition(
        GovLegalRequestStatus.IN_REVIEW,
        GovLegalRequestStatus.RECEIVED,
      ),
    ).toThrow(/Cannot move/);
  });

  it('rejects transitions out of terminal statuses', () => {
    for (const terminal of [
      GovLegalRequestStatus.FULFILLED,
      GovLegalRequestStatus.REJECTED,
      GovLegalRequestStatus.WITHDRAWN,
    ]) {
      expect(() =>
        assertLegalStatusTransition(
          terminal,
          GovLegalRequestStatus.IN_REVIEW,
        ),
      ).toThrow(/Cannot move/);
    }
  });

  it('rejects no-op status updates', () => {
    expect(() =>
      assertLegalStatusTransition(
        GovLegalRequestStatus.RECEIVED,
        GovLegalRequestStatus.RECEIVED,
      ),
    ).toThrow(/already/);
  });

  it('only open requests can be assigned', () => {
    expect(canAssignLegalRequest(GovLegalRequestStatus.RECEIVED)).toBe(true);
    expect(canAssignLegalRequest(GovLegalRequestStatus.IN_REVIEW)).toBe(true);
    expect(canAssignLegalRequest(GovLegalRequestStatus.FULFILLED)).toBe(false);
    expect(canAssignLegalRequest(GovLegalRequestStatus.WITHDRAWN)).toBe(false);
  });
});
