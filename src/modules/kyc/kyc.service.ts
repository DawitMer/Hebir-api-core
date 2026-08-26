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
  DocumentReviewStatus,
  DocumentSubmission,
} from './entities/document-submission.entity';
import { AuditTrail } from './entities/audit-trail.entity';
import {
  ComplianceAlert,
  AlertSeverity,
  AlertStatus,
} from './entities/compliance-alert.entity';
import { ReviewDecision, ReviewDecisionDto } from './dto/review-decision.dto';
import {
  ConfirmDocumentDto,
  PresignDocumentDto,
  StartVerificationDto,
  VehicleChangeDto,
} from './dto/document-upload.dto';
import { KycStorageService } from './kyc-storage.service';
import {
  documentRequiresExpiry,
  isApprovedKycDocumentLocked,
  isKycDocumentExpired,
} from './kyc-document-policy';
import { SubscriptionService } from '../subscription/subscription.service';
import { UserAccount } from '../auth/entities/user-account.entity';
import { Vehicle } from '../rides/entities/vehicle.entity';

/** Review queues are worked top-down; this bounds one page. */
const MAX_LIST_ROWS = 500;
const VEHICLE_CHANGE_DOC_TYPES = ['registration', 'insurance'] as const;

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
    @InjectRepository(Vehicle)
    private readonly vehicles: Repository<Vehicle>,
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
    if (existing && existing.status !== VerificationStatus.REJECTED) {
      if (existing.status !== VerificationStatus.APPROVED) {
        await this.ensureVehicleFromApplication(driverId, existing, dto);
      }
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
    await this.ensureVehicleFromApplication(driverId, created, dto);
    return created;
  }

  /**
   * KYC used to store make/model/plate only on the verification row, so
   * Profile → Vehicle stayed empty. Attach a vehicles row the first time.
   */
  private async ensureVehicleFromApplication(
    driverId: string,
    verification: DriverVerification,
    dto?: StartVerificationDto,
  ) {
    const existing = await this.vehicles.findOne({ where: { driverId } });
    if (existing) return;

    const plate = (dto?.licenseNumber ?? verification.licenseNumber)?.trim();
    const type = (dto?.vehicleType ?? verification.vehicleType)?.trim();
    if (!plate || !type) return;

    const parts = type.split(/\s+/).filter(Boolean);
    const make = parts[0];
    const model = parts.slice(1).join(' ') || make;
    await this.vehicles.save(
      this.vehicles.create({
        driverId,
        make,
        model,
        plate,
        capacity: 4,
        color: dto?.vehicleColor?.trim() || null,
      }),
    );
  }

  async getMyVerification(driverId: string) {
    const existing = await this.verifications.findOne({
      where: { driverId },
      order: { submittedAt: 'DESC' },
    });
    if (!existing) throw new NotFoundException('No KYC application yet');
    if (existing.status !== VerificationStatus.APPROVED) {
      await this.ensureVehicleFromApplication(driverId, existing);
    }
    return existing;
  }

  async listMyDocuments(driverId: string) {
    const verification = await this.getMyVerification(driverId);
    if (
      verification.status === VerificationStatus.APPROVED &&
      !verification.vehicleChangePending
    ) {
      await this.markDocumentsApproved(verification.id);
    }
    return this.listDocuments(verification.id);
  }

  /**
   * Dispatch eligibility: APPROVED KYC only. Unverified or pending drivers
   * must not receive marketplace offers even if they are still ONLINE.
   */
  async filterApprovedDriverIds(driverIds: string[]): Promise<Set<string>> {
    const unique = [...new Set(driverIds.filter(Boolean))];
    if (!unique.length) return new Set();
    const rows = await this.verifications.find({
      where: { driverId: In(unique), status: VerificationStatus.APPROVED },
      select: { driverId: true },
    });
    return new Set(rows.map((row) => row.driverId));
  }

  /**
   * Rider-facing driver photos: the latest non-rejected KYC selfie, keyed
   * by driver id. License / ID / insurance are never included.
   */
  async mapDriverPhotoUrls(driverIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(driverIds.filter(Boolean))];
    const urls = new Map<string, string>();
    if (!unique.length) return urls;

    const verifications = await this.verifications.find({
      where: { driverId: In(unique) },
      order: { submittedAt: 'DESC' },
    });
    const latestByDriver = new Map<string, DriverVerification>();
    for (const row of verifications) {
      if (!latestByDriver.has(row.driverId)) {
        latestByDriver.set(row.driverId, row);
      }
    }
    const verificationIds = [...latestByDriver.values()].map((row) => row.id);
    if (!verificationIds.length) return urls;

    const selfies = await this.documents.find({
      where: {
        driverVerificationId: In(verificationIds),
        documentType: 'selfie',
      },
      order: { submittedAt: 'DESC' },
    });
    const selfieByVerification = new Map<string, DocumentSubmission>();
    for (const doc of selfies) {
      if (doc.status === DocumentReviewStatus.REJECTED) continue;
      if (!selfieByVerification.has(doc.driverVerificationId)) {
        selfieByVerification.set(doc.driverVerificationId, doc);
      }
    }

    await Promise.all(
      [...latestByDriver.entries()].map(async ([driverId, verification]) => {
        const doc = selfieByVerification.get(verification.id);
        if (!doc) return;
        urls.set(
          driverId,
          await this.storage.createClientViewUrl(doc.storageKey),
        );
      }),
    );
    return urls;
  }

  /**
   * Store a replacement car for ops review. The live vehicles row is not
   * touched until they approve. License / ID / selfie stay locked.
   */
  async requestVehicleChange(driverId: string, dto: VehicleChangeDto) {
    const verification = await this.getMyVerification(driverId);
    if (verification.status === VerificationStatus.REJECTED) {
      throw new ConflictException(
        'This application was rejected. Start a new KYC application first.',
      );
    }
    if (verification.status !== VerificationStatus.APPROVED) {
      throw new ConflictException(
        'Finish your current application first, then add a vehicle for review.',
      );
    }

    const make = dto.make.trim();
    const model = dto.model.trim();
    const plate = dto.plate.trim();
    const color = dto.color?.trim() || null;
    if (!make || !model || !plate) {
      throw new BadRequestException('Make, model and plate are required');
    }

    const current = await this.vehicles.findOne({ where: { driverId } });
    if (
      current &&
      current.make.trim().toLowerCase() === make.toLowerCase() &&
      current.model.trim().toLowerCase() === model.toLowerCase() &&
      current.plate.trim().toLowerCase() === plate.toLowerCase()
    ) {
      throw new ConflictException(
        'This vehicle is already on file and cannot be edited.',
      );
    }

    verification.vehicleChangePending = true;
    verification.pendingVehicleMake = make;
    verification.pendingVehicleModel = model;
    verification.pendingVehiclePlate = plate;
    verification.pendingVehicleColor = color;
    verification.pendingVehicleYear = dto.year ?? verification.vehicleYear;
    verification.missingInsurance = true;
    await this.verifications.save(verification);

    const vehicleDocs = await this.documents.find({
      where: {
        driverVerificationId: verification.id,
        documentType: In([...VEHICLE_CHANGE_DOC_TYPES]),
      },
    });
    for (const doc of vehicleDocs) {
      if (doc.status === DocumentReviewStatus.APPROVED) {
        doc.status = DocumentReviewStatus.RESUBMISSION_REQUESTED;
      }
    }
    if (vehicleDocs.length) {
      await this.documents.save(vehicleDocs);
    }

    await this.complianceAlerts.save(
      this.complianceAlerts.create({
        driverId,
        title: 'Vehicle change requested',
        description: `${make} ${model} • ${plate} is waiting on registration and insurance review.`,
        severity: AlertSeverity.MEDIUM,
        status: AlertStatus.OPEN,
      }),
    );

    await this.recordAudit(
      driverId,
      'driver',
      'kyc.vehicle_change',
      verification.id,
      {
        make,
        model,
        plate,
      },
    );

    return verification;
  }

  async createPresign(driverId: string, dto: PresignDocumentDto) {
    const verification = await this.assertCanUpload(driverId, dto.documentType);

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
    const verification = await this.assertCanUpload(driverId, dto.documentType);
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
      throw new BadRequestException(
        'Upload session expired — request a new presign',
      );
    }

    await this.storage.markUploaded(dto.storageKey);

    const expiresAt = this.parseRequiredExpiry(dto.documentType, dto.expiresAt);

    const prior = await this.documents.find({
      where: {
        driverVerificationId: verification.id,
        documentType: dto.documentType,
      },
    });
    const replacingExpired = prior.some((doc) =>
      isKycDocumentExpired(doc.expiresAt),
    );
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
        expiresAt,
        reviewedAt: null,
      }),
    );

    await this.refreshMissingFlags(verification.id);
    if (verification.status === VerificationStatus.PENDING) {
      verification.status = VerificationStatus.IN_REVIEW;
      await this.verifications.save(verification);
    }

    if (replacingExpired) {
      await this.complianceAlerts.save(
        this.complianceAlerts.create({
          driverId,
          title: 'Expired document replaced',
          description: `Driver uploaded a new ${dto.documentType} after expiry.`,
          severity: AlertSeverity.MEDIUM,
          status: AlertStatus.OPEN,
        }),
      );
    }

    await this.recordAudit(
      driverId,
      'driver',
      'kyc.document_upload',
      saved.id,
      {
        documentType: dto.documentType,
        storageKey: dto.storageKey,
      },
    );

    return {
      ...saved,
      viewUrl: await this.storage.createViewUrl(saved.storageKey),
    };
  }

  async readLocalForAdmin(storageKey: string) {
    return this.storage.readLocalBody(storageKey);
  }

  /**
   * Missing types can still be added. Approved files stay on file with their
   * dates until they expire or ops requests a resubmission.
   */
  private async assertCanUpload(driverId: string, documentType: string) {
    const verification = await this.getMyVerification(driverId);
    if (verification.status === VerificationStatus.REJECTED) {
      throw new ConflictException(
        'This application was rejected. Start a new KYC application first.',
      );
    }

    if (
      verification.status === VerificationStatus.APPROVED &&
      !verification.vehicleChangePending
    ) {
      await this.markDocumentsApproved(verification.id);
    }

    const existing = await this.documents.findOne({
      where: {
        driverVerificationId: verification.id,
        documentType,
      },
      order: { submittedAt: 'DESC' },
    });

    if (existing && isApprovedKycDocumentLocked(existing)) {
      throw new ConflictException(
        'This document is approved and cannot be changed. Dates stay on file until it expires.',
      );
    }

    return verification;
  }

  private parseRequiredExpiry(documentType: string, raw?: string): Date | null {
    if (!raw) {
      if (documentRequiresExpiry(documentType)) {
        throw new BadRequestException(
          'Expiry date is required for this document',
        );
      }
      return null;
    }

    const expiresAt = new Date(raw);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new BadRequestException('Expiry date is invalid');
    }
    if (
      documentRequiresExpiry(documentType) &&
      expiresAt.getTime() <= Date.now()
    ) {
      throw new BadRequestException('Expiry date must be in the future');
    }
    return expiresAt;
  }

  private async markDocumentsApproved(verificationId: string) {
    const docs = await this.documents.find({
      where: { driverVerificationId: verificationId },
    });
    const reviewedAt = new Date();
    const changed = docs.filter(
      (doc) =>
        doc.status === DocumentReviewStatus.QUEUED ||
        doc.status === DocumentReviewStatus.UNDER_REVIEW,
    );
    for (const doc of changed) {
      doc.status = DocumentReviewStatus.APPROVED;
      doc.reviewedAt = reviewedAt;
    }
    if (changed.length) {
      await this.documents.save(changed);
    }
  }

  private async refreshMissingFlags(verificationId: string) {
    const verification = await this.getVerification(verificationId);
    const docs = await this.documents.find({
      where: { driverVerificationId: verificationId },
    });
    const types = new Set(
      docs
        .filter((d) => !isKycDocumentExpired(d.expiresAt))
        .map((d) => d.documentType),
    );
    verification.missingId = !types.has('national_id') && !types.has('license');
    verification.missingInsurance = !types.has('insurance');
    await this.verifications.save(verification);
  }

  async assign(
    id: string,
    agentId: string,
    actorId: string,
    actorRole: string,
  ) {
    const verification = await this.getVerification(id);
    verification.assignedToId = agentId;
    verification.status = VerificationStatus.IN_REVIEW;
    await this.verifications.save(verification);
    await this.recordAudit(actorId, actorRole, 'kyc.assign', verification.id, {
      agentId,
    });
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
      verification.status === VerificationStatus.APPROVED &&
      verification.vehicleChangePending
    ) {
      return this.decideVehicleChange(verification, dto, actorId, actorRole);
    }

    if (
      verification.status === VerificationStatus.APPROVED ||
      verification.status === VerificationStatus.REJECTED
    ) {
      throw new ConflictException('This application has already been decided');
    }

    switch (dto.decision) {
      case ReviewDecision.APPROVE:
        verification.status = VerificationStatus.APPROVED;
        await this.markDocumentsApproved(verification.id);
        await this.applyPendingVehicle(verification);
        break;
      case ReviewDecision.REJECT:
        verification.status = VerificationStatus.REJECTED;
        verification.rejectionReason = dto.reason ?? null;
        this.clearPendingVehicle(verification);
        break;
      case ReviewDecision.ESCALATE:
        verification.status = VerificationStatus.ESCALATED;
        verification.escalationReason = dto.reason ?? null;
        verification.escalatedToId = dto.escalateToId ?? null;
        break;
    }

    await this.verifications.save(verification);
    await this.recordAudit(
      actorId,
      actorRole,
      `kyc.${dto.decision}`,
      verification.id,
      {
        reason: dto.reason,
      },
    );

    return verification;
  }

  private async decideVehicleChange(
    verification: DriverVerification,
    dto: ReviewDecisionDto,
    actorId: string,
    actorRole: string,
  ) {
    switch (dto.decision) {
      case ReviewDecision.APPROVE:
        await this.applyPendingVehicle(verification);
        await this.markDocumentsApproved(verification.id);
        break;
      case ReviewDecision.REJECT:
        this.clearPendingVehicle(verification);
        await this.rejectQueuedVehicleDocs(verification.id);
        break;
      case ReviewDecision.ESCALATE:
        verification.escalationReason = dto.reason ?? null;
        verification.escalatedToId = dto.escalateToId ?? null;
        break;
    }

    await this.verifications.save(verification);
    await this.recordAudit(
      actorId,
      actorRole,
      `kyc.vehicle_change.${dto.decision}`,
      verification.id,
      { reason: dto.reason },
    );
    return verification;
  }

  private async applyPendingVehicle(verification: DriverVerification) {
    const make = verification.pendingVehicleMake?.trim();
    const model = verification.pendingVehicleModel?.trim();
    const plate = verification.pendingVehiclePlate?.trim();
    if (!make || !model || !plate) {
      this.clearPendingVehicle(verification);
      return;
    }

    let vehicle = await this.vehicles.findOne({
      where: { driverId: verification.driverId },
    });
    if (!vehicle) {
      vehicle = this.vehicles.create({
        driverId: verification.driverId,
        make,
        model,
        plate,
        capacity: 4,
        color: verification.pendingVehicleColor,
      });
    } else {
      vehicle.make = make;
      vehicle.model = model;
      vehicle.plate = plate;
      if (verification.pendingVehicleColor) {
        vehicle.color = verification.pendingVehicleColor;
      }
    }
    await this.vehicles.save(vehicle);

    verification.licenseNumber = plate;
    verification.vehicleType = `${make} ${model}`.trim();
    if (verification.pendingVehicleYear) {
      verification.vehicleYear = verification.pendingVehicleYear;
    }
    this.clearPendingVehicle(verification);
  }

  private clearPendingVehicle(verification: DriverVerification) {
    verification.vehicleChangePending = false;
    verification.pendingVehicleMake = null;
    verification.pendingVehicleModel = null;
    verification.pendingVehiclePlate = null;
    verification.pendingVehicleColor = null;
    verification.pendingVehicleYear = null;
  }

  private async rejectQueuedVehicleDocs(verificationId: string) {
    const docs = await this.documents.find({
      where: {
        driverVerificationId: verificationId,
        documentType: In([...VEHICLE_CHANGE_DOC_TYPES]),
      },
    });
    const changed = docs.filter(
      (doc) =>
        doc.status === DocumentReviewStatus.QUEUED ||
        doc.status === DocumentReviewStatus.UNDER_REVIEW ||
        doc.status === DocumentReviewStatus.RESUBMISSION_REQUESTED,
    );
    for (const doc of changed) {
      doc.status = DocumentReviewStatus.REJECTED;
    }
    if (changed.length) {
      await this.documents.save(changed);
    }
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
    await this.recordAudit(
      actorId,
      actorRole,
      'compliance.resolve',
      alert.id,
      {},
    );
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

    const verificationIds = [
      ...new Set(docs.map((d) => d.driverVerificationId)),
    ];
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
