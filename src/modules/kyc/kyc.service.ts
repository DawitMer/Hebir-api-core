import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  DriverVerification,
  VerificationStatus,
} from './entities/driver-verification.entity';
import {
  DocumentCategory,
  DocumentReviewStatus,
  DocumentSubmission,
} from './entities/document-submission.entity';
import { AuditTrail } from './entities/audit-trail.entity';
import { ComplianceAlert, AlertStatus } from './entities/compliance-alert.entity';
import { ReviewDecision, ReviewDecisionDto } from './dto/review-decision.dto';
import {
  ConfirmDocumentDto,
  PresignDocumentDto,
  StartVerificationDto,
} from './dto/document-upload.dto';
import { KycStorageService } from './kyc-storage.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { UserAccount } from '../auth/entities/user-account.entity';

/** Review queues are worked top-down; this bounds one page. */
const MAX_LIST_ROWS = 500;

@Injectable()
export class KycService {
  constructor(
    @InjectRepository(DriverVerification)
    private readonly verifications: Repository<DriverVerification>,
    @InjectRepository(DocumentSubmission)
    private readonly documents: Repository<DocumentSubmission>,
    @InjectRepository(AuditTrail)
    private readonly auditTrails: Repository<AuditTrail>,
    @InjectRepository(ComplianceAlert)
    private readonly complianceAlerts: Repository<ComplianceAlert>,
    @InjectRepository(UserAccount)
    private readonly users: Repository<UserAccount>,
    private readonly subscriptionService: SubscriptionService,
    private readonly storage: KycStorageService,
  ) {}

  async listQueue(status?: VerificationStatus) {
    const rows = await this.verifications.find({
      where: status ? { status } : {},
      order: { submittedAt: 'ASC' },
      take: MAX_LIST_ROWS,
    });
    const names = await this.driverNameMap(rows.map((r) => r.driverId));
    return rows.map((r) => ({
      ...r,
      driverName: names.get(r.driverId) ?? r.driverId,
    }));
  }

  async getVerification(id: string) {
    const verification = await this.verifications.findOne({ where: { id } });
    if (!verification) throw new NotFoundException('Verification not found');
    return verification;
  }

  async listDocuments(driverVerificationId: string) {
    const rows = await this.documents.find({
      where: { driverVerificationId },
      order: { submittedAt: 'DESC' },
      take: MAX_LIST_ROWS,
    });
    return Promise.all(
      rows.map(async (doc) => ({
        ...doc,
        viewUrl: await this.storage.createViewUrl(doc.storageKey),
        storageMode: this.storage.storageMode,
      })),
    );
  }

  async startOrGetMyVerification(driverId: string, dto: StartVerificationDto) {
    const existing = await this.verifications.findOne({
      where: { driverId },
      order: { submittedAt: 'DESC' },
    });
    if (
      existing &&
      existing.status !== VerificationStatus.REJECTED
    ) {
      return existing;
    }

    const year = dto.vehicleYear ?? new Date().getFullYear();
    const created = await this.verifications.save(
      this.verifications.create({
        driverId,
        licenseNumber: dto.licenseNumber,
        region: dto.region,
        vehicleType: dto.vehicleType,
        vehicleYear: year,
        status: VerificationStatus.PENDING,
      }),
    );
    await this.recordAudit(driverId, 'driver', 'kyc.submit', created.id, {
      licenseNumber: dto.licenseNumber,
    });
    return created;
  }

  async getMyVerification(driverId: string) {
    const existing = await this.verifications.findOne({
      where: { driverId },
      order: { submittedAt: 'DESC' },
    });
    if (!existing) throw new NotFoundException('No KYC application yet');
    return existing;
  }

  async listMyDocuments(driverId: string) {
    const verification = await this.getMyVerification(driverId);
    return this.listDocuments(verification.id);
  }

  async createPresign(driverId: string, dto: PresignDocumentDto) {
    const verification = await this.getMyVerification(driverId);
    if (
      verification.status === VerificationStatus.APPROVED ||
      verification.status === VerificationStatus.REJECTED
    ) {
      throw new ConflictException(
        'Cannot upload documents for a closed application',
      );
    }

    const storageKey = this.storage.buildObjectKey(
      driverId,
      dto.documentType,
      dto.contentType,
    );
    const { uploadUrl, headers } = await this.storage.createUploadUrl({
      driverId,
      storageKey,
      contentType: dto.contentType,
    });

    return {
      storageKey,
      uploadUrl,
      headers,
      storageMode: this.storage.storageMode,
      expiresInSeconds: 900,
      verificationId: verification.id,
    };
  }

  async saveLocalUpload(
    driverId: string,
    storageKey: string,
    body: Buffer,
    contentType?: string,
  ) {
    if (!storageKey.startsWith(`kyc/${driverId}/`)) {
      throw new ForbiddenException('Invalid storage key');
    }
    try {
      await this.storage.saveLocalBody(storageKey, body, driverId);
    } catch {
      throw new BadRequestException('Upload not authorized or expired');
    }
    return { ok: true, storageKey, contentType: contentType ?? null };
  }

  async confirmUpload(driverId: string, dto: ConfirmDocumentDto) {
    const verification = await this.getMyVerification(driverId);
    if (!dto.storageKey.startsWith(`kyc/${driverId}/`)) {
      throw new ForbiddenException('Invalid storage key');
    }

    const pending = await this.storage.assertPendingUpload(
      dto.storageKey,
      driverId,
    );
    // After a successful local PUT we may have already cleared the Redis key;
    // for S3 the object is external — accept either pending or key ownership.
    if (!pending && this.storage.storageMode === 'local') {
      const bytes = await this.storage.readLocalBody(dto.storageKey);
      if (!bytes) {
        throw new BadRequestException(
          'File not found — upload the bytes before confirming',
        );
      }
    } else if (!pending && this.storage.storageMode === 's3') {
      // S3 PUT does not clear Redis until confirm; require pending token.
      throw new BadRequestException('Upload session expired — request a new presign');
    }

    await this.storage.markUploaded(dto.storageKey);

    // Replace prior submission of the same type on this verification.
    const prior = await this.documents.find({
      where: {
        driverVerificationId: verification.id,
        documentType: dto.documentType,
      },
    });
    if (prior.length) {
      await this.documents.remove(prior);
    }

    const saved = await this.documents.save(
      this.documents.create({
        driverVerificationId: verification.id,
        documentType: dto.documentType,
        category: dto.category,
        storageKey: dto.storageKey,
        status: DocumentReviewStatus.QUEUED,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      }),
    );

    await this.refreshMissingFlags(verification.id);
    if (verification.status === VerificationStatus.PENDING) {
      verification.status = VerificationStatus.IN_REVIEW;
      await this.verifications.save(verification);
    }

    await this.recordAudit(driverId, 'driver', 'kyc.document_upload', saved.id, {
      documentType: dto.documentType,
      storageKey: dto.storageKey,
    });

    return {
      ...saved,
      viewUrl: await this.storage.createViewUrl(saved.storageKey),
    };
  }

  async readLocalForAdmin(storageKey: string) {
    return this.storage.readLocalBody(storageKey);
  }

  private async refreshMissingFlags(verificationId: string) {
    const verification = await this.getVerification(verificationId);
    const docs = await this.documents.find({
      where: { driverVerificationId: verificationId },
    });
    const types = new Set(docs.map((d) => d.documentType));
    verification.missingId = !types.has('national_id') && !types.has('license');
    verification.missingInsurance = !types.has('insurance');
    await this.verifications.save(verification);
  }

  async assign(id: string, agentId: string, actorId: string, actorRole: string) {
    const verification = await this.getVerification(id);
    verification.assignedToId = agentId;
    verification.status = VerificationStatus.IN_REVIEW;
    await this.verifications.save(verification);
    await this.recordAudit(actorId, actorRole, 'kyc.assign', verification.id, { agentId });
    return verification;
  }

  async decide(
    id: string,
    dto: ReviewDecisionDto,
    actorId: string,
    actorRole: string,
  ) {
    const verification = await this.getVerification(id);

    if (
      verification.status === VerificationStatus.APPROVED ||
      verification.status === VerificationStatus.REJECTED
    ) {
      throw new ConflictException('This application has already been decided');
    }

    switch (dto.decision) {
      case ReviewDecision.APPROVE:
        verification.status = VerificationStatus.APPROVED;
        break;
      case ReviewDecision.REJECT:
        verification.status = VerificationStatus.REJECTED;
        verification.rejectionReason = dto.reason ?? null;
        break;
      case ReviewDecision.ESCALATE:
        verification.status = VerificationStatus.ESCALATED;
        verification.escalationReason = dto.reason ?? null;
        verification.escalatedToId = dto.escalateToId ?? null;
        break;
    }

    await this.verifications.save(verification);
    await this.recordAudit(actorId, actorRole, `kyc.${dto.decision}`, verification.id, {
      reason: dto.reason,
    });

    return verification;
  }

  async listComplianceAlerts(status?: AlertStatus) {
    const rows = await this.complianceAlerts.find({
      where: status ? { status } : {},
      order: { raisedAt: 'DESC' },
      take: MAX_LIST_ROWS,
    });
    const names = await this.driverNameMap(rows.map((r) => r.driverId));
    return rows.map((r) => ({
      ...r,
      driverName: names.get(r.driverId) ?? r.driverId,
    }));
  }

  async resolveAlert(id: string, actorId: string, actorRole: string) {
    const alert = await this.complianceAlerts.findOne({ where: { id } });
    if (!alert) throw new NotFoundException('Alert not found');
    alert.status = AlertStatus.RESOLVED;
    await this.complianceAlerts.save(alert);
    await this.recordAudit(actorId, actorRole, 'compliance.resolve', alert.id, {});
    return alert;
  }

  /**
   * Documents with `expiresAt` set — powers Ops portal "Document expirations"
   * from the same KYC uploads Driver apps submit.
   */
  async listDocumentExpirations() {
    const docs = await this.documents
      .createQueryBuilder('d')
      .where('d.expiresAt IS NOT NULL')
      .orderBy('d.expiresAt', 'ASC')
      .take(MAX_LIST_ROWS)
      .getMany();

    const verificationIds = [...new Set(docs.map((d) => d.driverVerificationId))];
    const verifications =
      verificationIds.length === 0
        ? []
        : await this.verifications.find({
            where: { id: In(verificationIds) },
          });
    const verificationById = new Map(verifications.map((v) => [v.id, v]));
    const names = await this.driverNameMap(
      verifications.map((v) => v.driverId),
    );

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    let expiringIn7Days = 0;
    let expiringIn30Days = 0;
    let alreadyExpired = 0;

    const items = docs.map((d) => {
      const verification = verificationById.get(d.driverVerificationId);
      const expiresAt = d.expiresAt!;
      const daysLeft = Math.ceil((expiresAt.getTime() - now) / dayMs);
      if (daysLeft < 0) alreadyExpired += 1;
      else if (daysLeft <= 7) expiringIn7Days += 1;
      else if (daysLeft <= 30) expiringIn30Days += 1;

      return {
        id: d.id,
        driverId: verification?.driverId ?? null,
        driverName: verification
          ? (names.get(verification.driverId) ?? verification.driverId)
          : '—',
        documentType: d.documentType,
        category: d.category,
        expiresAt: expiresAt.toISOString(),
        daysLeft,
        status: d.status,
      };
    });

    return {
      metrics: {
        expiringIn7Days,
        expiringIn30Days,
        alreadyExpired,
        totalEntries: items.length,
      },
      items,
    };
  }

  listAuditTrail(targetId?: string) {
    return this.auditTrails.find({
      where: targetId ? { targetId } : {},
      order: { occurredAt: 'DESC' },
      take: 200,
    });
  }

  private async driverNameMap(driverIds: string[]) {
    const ids = [...new Set(driverIds.filter(Boolean))];
    if (ids.length === 0) return new Map<string, string>();
    const users = await this.users.find({ where: { id: In(ids) } });
    return new Map(
      users.map((u) => [u.id, u.fullName || u.phoneNumber || u.id]),
    );
  }

  private async recordAudit(
    actorId: string,
    actorRole: string,
    action: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.auditTrails.save(
      this.auditTrails.create({
        actorId,
        actorRole,
        action,
        targetType: 'driver_verification',
        targetId,
        metadata,
      }),
    );
  }
}
