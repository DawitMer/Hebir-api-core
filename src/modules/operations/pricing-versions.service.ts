import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { FareService } from '../fare/fare.service';
import type { FareRates } from '../fare/fare-rates';
import { FareRateKeys } from '../fare/fare-rates';
import { ConfigurationService } from '../subscription/configuration.service';
import { AuditTrail } from '../kyc/entities/audit-trail.entity';
import {
  FareAdjustment,
  PricingVersion,
  type PricingVersionStatus,
  type VehicleMultipliers,
} from './entities/pricing-version.entity';
import { Ride } from '../rides/entities/ride.entity';
import { FareRecord } from '../rides/entities/fare-record.entity';

const DEFAULT_VEHICLE_MULTIPLIERS: VehicleMultipliers = {
  any: 1,
  sedan: 1,
  economy: 1,
  comfort: 1.15,
  suv: 1.25,
  xl: 1.25,
  premium: 1.4,
  taxi: 1,
  motorcycle: 0.7,
  moto: 0.7,
};

@Injectable()
export class PricingVersionsService implements OnModuleInit {
  private readonly logger = new Logger(PricingVersionsService.name);

  constructor(
    @InjectRepository(PricingVersion)
    private readonly versions: Repository<PricingVersion>,
    @InjectRepository(FareAdjustment)
    private readonly adjustments: Repository<FareAdjustment>,
    @InjectRepository(AuditTrail)
    private readonly audit: Repository<AuditTrail>,
    @InjectRepository(Ride)
    private readonly rides: Repository<Ride>,
    @InjectRepository(FareRecord)
    private readonly fares: Repository<FareRecord>,
    private readonly fareService: FareService,
    private readonly configuration: ConfigurationService,
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit() {
    await this.ensureActiveFromLiveRates();
  }

  /** Boot: if no active version, snapshot current configuration rates. */
  async ensureActiveFromLiveRates() {
    const active = await this.versions.findOne({ where: { status: 'active' } });
    if (active) return;
    const rates = this.fareService.getRates();
    const row = await this.versions.save(
      this.versions.create({
        versionLabel: `bootstrap-${new Date().toISOString().slice(0, 10)}`,
        status: 'active',
        currency: 'ETB',
        rates,
        vehicleMultipliers: DEFAULT_VEHICLE_MULTIPLIERS,
        notes: 'Auto-created from live configuration on first boot',
        activatedAt: new Date(),
        effectiveFrom: new Date(),
      }),
    );
    this.logger.log(`Seeded active pricing version ${row.id}`);
  }

  async getActive(): Promise<PricingVersion | null> {
    return this.versions.findOne({
      where: { status: 'active' },
      order: { activatedAt: 'DESC' },
    });
  }

  /** Rates for new quotes — active version, else live configuration. */
  async getActiveRates(): Promise<{
    rates: FareRates;
    version: PricingVersion | null;
  }> {
    const version = await this.getActive();
    if (version) return { rates: version.rates, version };
    return { rates: this.fareService.getRates(), version: null };
  }

  list(status?: PricingVersionStatus) {
    return this.versions.find({
      where: status ? { status } : {},
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }

  async get(id: string) {
    const row = await this.versions.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Pricing version not found');
    return row;
  }

  async createDraft(
    actorId: string,
    input: {
      versionLabel: string;
      rates: FareRates;
      vehicleMultipliers?: VehicleMultipliers;
      notes?: string;
      effectiveFrom?: string;
    },
  ) {
    const row = await this.versions.save(
      this.versions.create({
        versionLabel: input.versionLabel,
        status: 'draft',
        rates: input.rates,
        vehicleMultipliers: {
          ...DEFAULT_VEHICLE_MULTIPLIERS,
          ...(input.vehicleMultipliers ?? {}),
        },
        notes: input.notes ?? null,
        effectiveFrom: input.effectiveFrom
          ? new Date(input.effectiveFrom)
          : null,
        createdById: actorId,
      }),
    );
    await this.audit.save(
      this.audit.create({
        actorId,
        actorRole: 'admin',
        action: 'pricing.draft_create',
        targetType: 'pricing_version',
        targetId: row.id,
        metadata: { versionLabel: row.versionLabel, rates: row.rates },
      }),
    );
    return row;
  }

  async updateDraft(
    actorId: string,
    id: string,
    patch: Partial<{
      versionLabel: string;
      rates: FareRates;
      vehicleMultipliers: VehicleMultipliers;
      notes: string;
      effectiveFrom: string | null;
      status: Extract<PricingVersionStatus, 'draft' | 'review'>;
    }>,
  ) {
    const row = await this.get(id);
    if (row.status !== 'draft' && row.status !== 'review') {
      throw new BadRequestException('Only draft/review versions can be edited');
    }
    const previous = { ...row };
    if (patch.versionLabel != null) row.versionLabel = patch.versionLabel;
    if (patch.rates != null) row.rates = patch.rates;
    if (patch.vehicleMultipliers != null) {
      row.vehicleMultipliers = patch.vehicleMultipliers;
    }
    if (patch.notes != null) row.notes = patch.notes;
    if (patch.effectiveFrom !== undefined) {
      row.effectiveFrom = patch.effectiveFrom
        ? new Date(patch.effectiveFrom)
        : null;
    }
    if (patch.status) row.status = patch.status;
    await this.versions.save(row);
    await this.audit.save(
      this.audit.create({
        actorId,
        actorRole: 'admin',
        action: 'pricing.draft_update',
        targetType: 'pricing_version',
        targetId: row.id,
        metadata: { previous: previous.rates, next: row.rates },
      }),
    );
    return row;
  }

  /**
   * Publish + activate: archives previous active version.
   * Existing trips keep their quotedFareRates / pricingVersionId.
   */
  async publishAndActivate(actorId: string, id: string) {
    return this.dataSource.transaction(async (em) => {
      const versions = em.getRepository(PricingVersion);
      const row = await versions.findOne({ where: { id } });
      if (!row) throw new NotFoundException('Pricing version not found');
      if (row.status === 'archived') {
        throw new BadRequestException('Cannot activate an archived version');
      }

      const currentActive = await versions.findOne({
        where: { status: 'active' },
      });
      if (currentActive && currentActive.id !== row.id) {
        currentActive.status = 'archived';
        currentActive.archivedAt = new Date();
        await versions.save(currentActive);
      }

      row.status = 'active';
      row.activatedAt = new Date();
      row.publishedById = actorId;
      if (!row.effectiveFrom) row.effectiveFrom = new Date();
      await versions.save(row);

      // Keep configuration table in sync for FareService.getRates() readers.
      await this.configuration.setMany([
        {
          key: FareRateKeys.initialFeeEtb,
          value: row.rates.initialFeeEtb,
          description: 'Synced from active pricing version',
        },
        {
          key: FareRateKeys.perMeterEtb,
          value: row.rates.perMeterEtb,
          description: 'Synced from active pricing version',
        },
        {
          key: FareRateKeys.perMinuteEtb,
          value: row.rates.perMinuteEtb,
          description: 'Synced from active pricing version',
        },
        {
          key: FareRateKeys.perWaitMinuteEtb,
          value: row.rates.perWaitMinuteEtb,
          description: 'Synced from active pricing version',
        },
        {
          key: FareRateKeys.minimumEtb,
          value: row.rates.minimumEtb,
          description: 'Synced from active pricing version',
        },
        {
          key: FareRateKeys.surgeMaxMultiplier,
          value: row.rates.surgeMaxMultiplier,
          description: 'Synced from active pricing version',
        },
      ]);

      await em.getRepository(AuditTrail).save(
        em.getRepository(AuditTrail).create({
          actorId,
          actorRole: 'admin',
          action: 'pricing.publish_activate',
          targetType: 'pricing_version',
          targetId: row.id,
          metadata: {
            rates: row.rates,
            previousActiveId: currentActive?.id ?? null,
          },
        }),
      );
      return row;
    });
  }

  async adjustFare(
    actorId: string,
    rideId: string,
    input: { adjustedTotal: number; reason: string; internalNote?: string },
  ) {
    if (!input.reason?.trim()) {
      throw new BadRequestException('Reason is required for fare adjustments');
    }
    if (!Number.isFinite(input.adjustedTotal) || input.adjustedTotal < 0) {
      throw new BadRequestException('adjustedTotal must be a non-negative number');
    }

    return this.dataSource.transaction(async (em) => {
      const ride = await em.getRepository(Ride).findOne({ where: { id: rideId } });
      if (!ride) throw new NotFoundException('Ride not found');
      const original = Number(ride.fare ?? 0);
      const adj = await em.getRepository(FareAdjustment).save(
        em.getRepository(FareAdjustment).create({
          rideId,
          staffUserId: actorId,
          originalTotal: original.toFixed(2),
          adjustedTotal: input.adjustedTotal.toFixed(2),
          reason: input.reason.trim(),
          internalNote: input.internalNote?.trim() ?? null,
        }),
      );
      await em.getRepository(Ride).update(
        { id: rideId },
        {
          fare: String(Math.round(input.adjustedTotal)),
          fareBreakdown: {
            ...(ride.fareBreakdown ?? {}),
            total: Math.round(input.adjustedTotal),
            manualAdjustment: {
              adjustmentId: adj.id,
              originalTotal: original,
              adjustedTotal: input.adjustedTotal,
              reason: input.reason.trim(),
              staffUserId: actorId,
              at: new Date().toISOString(),
            },
          },
        },
      );
      const fareRec = await em.getRepository(FareRecord).findOne({
        where: { rideId },
      });
      if (fareRec) {
        await em.getRepository(FareRecord).update(
          { id: fareRec.id },
          { total: input.adjustedTotal.toFixed(2) },
        );
      }
      await em.getRepository(AuditTrail).save(
        em.getRepository(AuditTrail).create({
          actorId,
          actorRole: 'admin',
          action: 'fare.manual_adjustment',
          targetType: 'ride',
          targetId: rideId,
          metadata: {
            originalTotal: original,
            adjustedTotal: input.adjustedTotal,
            reason: input.reason,
            adjustmentId: adj.id,
          },
        }),
      );
      return adj;
    });
  }
}
