import { BadRequestException } from '@nestjs/common';
import { GovLegalRequestStatus } from './entities/gov-legal-request.entity';

const ALLOWED: Record<GovLegalRequestStatus, GovLegalRequestStatus[]> = {
  [GovLegalRequestStatus.RECEIVED]: [
    GovLegalRequestStatus.IN_REVIEW,
    GovLegalRequestStatus.REJECTED,
    GovLegalRequestStatus.WITHDRAWN,
  ],
  [GovLegalRequestStatus.IN_REVIEW]: [
    GovLegalRequestStatus.FULFILLED,
    GovLegalRequestStatus.REJECTED,
    GovLegalRequestStatus.WITHDRAWN,
  ],
  [GovLegalRequestStatus.FULFILLED]: [],
  [GovLegalRequestStatus.REJECTED]: [],
  [GovLegalRequestStatus.WITHDRAWN]: [],
};

export function assertLegalStatusTransition(
  from: GovLegalRequestStatus,
  to: GovLegalRequestStatus,
): void {
  if (from === to) {
    throw new BadRequestException(`Request is already ${from}`);
  }
  const allowed = ALLOWED[from] ?? [];
  if (!allowed.includes(to)) {
    throw new BadRequestException(
      `Cannot move legal request from ${from} to ${to}`,
    );
  }
}

export function canAssignLegalRequest(status: GovLegalRequestStatus): boolean {
  return (
    status === GovLegalRequestStatus.RECEIVED ||
    status === GovLegalRequestStatus.IN_REVIEW
  );
}
