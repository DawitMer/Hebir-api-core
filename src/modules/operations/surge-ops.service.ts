import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigurationService } from '../subscription/configuration.service';
import { AuditTrail } from '../kyc/entities/audit-trail.entity';
import { FareService } from '../fare/fare.service';

export const SurgeConfigKeys = {
  overrideEnabled: 'surge_override_enabled',
  overrideMultiplier: 'surge_override_multiplier',
  zoneOverrides: 'surge_zone_overrides',
  maxMultiplier: 'surge_max_multiplier',
  minActiveRiders: 'surge_min_active_riders',
  maxStepUp: 'surge_max_step_up',
  maxStepDown: 'surge_max_step_down',
  neighborBlend: 'surge_neighbor_blend',
} as const;

export interface SurgeOpsState {
  /** When true, live demand is ignored for matching zones / globally. */
  overrideEnabled: boolean;
  /** Global forced multiplier (1 = off effect when enabled alone). */
  overrideMultiplier: number;
  /** Per H3 zone forced multipliers (take precedence over global). */
  zoneOverrides: Record<string, number>;
  maxMultiplier: number;
  minActiveRiders: number;
  maxStepUp: number;
  maxStepDown: number;
  neighborBlend: number;
}

@Injectable()
export class SurgeOpsService {
  private readonly logger = new Logger(SurgeOpsService.name);

  constructor(
    private readonly configuration: ConfigurationService,
    private readonly fareService: FareService,
    @InjectRepository(AuditTrail)
    private readonly audit: Repository<AuditTrail>,
  ) {}

  getState(): SurgeOpsState {
    return {
      overrideEnabled: this.readBool(SurgeConfigKeys.overrideEnabled, false),
      overrideMultiplier: this.readNumber(
        SurgeConfigKeys.overrideMultiplier,
        1,
      ),
      zoneOverrides: this.readZoneMap(),
      maxMultiplier: this.readNumber(SurgeConfigKeys.maxMultiplier, 2.5),
      minActiveRiders: this.readNumber(SurgeConfigKeys.minActiveRiders, 2),
      maxStepUp: this.readNumber(SurgeConfigKeys.maxStepUp, 0.2),
      maxStepDown: this.readNumber(SurgeConfigKeys.maxStepDown, 0.3),
      neighborBlend: this.readNumber(SurgeConfigKeys.neighborBlend, 0.35),
    };
  }

  /**
   * Resolve ops override for a zone. Returns null when demand surge should run.
   * Never trusts client-supplied multipliers — only Neon configuration.
   */
  resolveOverride(zoneId?: string | null): number | null {
    const state = this.getState();
    if (!state.overrideEnabled) return null;
    const max = Math.max(1, state.maxMultiplier);
    if (zoneId && state.zoneOverrides[zoneId] != null) {
      const z = Number(state.zoneOverrides[zoneId]);
      if (Number.isFinite(z) && z >= 1) {
        return Math.min(Math.max(1, z), max);
      }
    }
    const g = Number(state.overrideMultiplier);
    if (!Number.isFinite(g) || g < 1) return 1;
    return Math.min(Math.max(1, g), max);
  }

  async update(
    actorId: string,
    patch: Partial<{
      overrideEnabled: boolean;
      overrideMultiplier: number;
      zoneOverrides: Record<string, number>;
      maxMultiplier: number;
      minActiveRiders: number;
      maxStepUp: number;
      maxStepDown: number;
      neighborBlend: number;
      clearZoneOverrides: boolean;
    }>,
  ): Promise<SurgeOpsState> {
    const previous = this.getState();
    const updates: Array<{ key: string; value: unknown; description: string }> =
      [];

    if (typeof patch.overrideEnabled === 'boolean') {
      updates.push({
        key: SurgeConfigKeys.overrideEnabled,
        value: patch.overrideEnabled,
        description: 'Ops manual surge override master switch',
      });
    }
    if (typeof patch.overrideMultiplier === 'number') {
      if (patch.overrideMultiplier < 1) {
        throw new BadRequestException('overrideMultiplier must be >= 1');
      }
      updates.push({
        key: SurgeConfigKeys.overrideMultiplier,
        value: patch.overrideMultiplier,
        description: 'Global forced surge multiplier when override is enabled',
      });
    }
    if (patch.clearZoneOverrides) {
      updates.push({
        key: SurgeConfigKeys.zoneOverrides,
        value: {},
        description: 'Per-zone forced surge multipliers (H3 cell id → multiplier)',
      });
    } else if (patch.zoneOverrides && typeof patch.zoneOverrides === 'object') {
      const cleaned: Record<string, number> = {
        ...previous.zoneOverrides,
      };
      for (const [zoneId, raw] of Object.entries(patch.zoneOverrides)) {
        const id = String(zoneId).trim();
        if (!id) continue;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 1) {
          delete cleaned[id];
        } else {
          cleaned[id] = n;
        }
      }
      updates.push({
        key: SurgeConfigKeys.zoneOverrides,
        value: cleaned,
        description: 'Per-zone forced surge multipliers (H3 cell id → multiplier)',
      });
    }
    if (typeof patch.maxMultiplier === 'number') {
      if (patch.maxMultiplier < 1) {
        throw new BadRequestException('maxMultiplier must be >= 1');
      }
      updates.push({
        key: SurgeConfigKeys.maxMultiplier,
        value: patch.maxMultiplier,
        description: 'Maximum surge multiplier from demand or override',
      });
    }
    if (typeof patch.minActiveRiders === 'number') {
      updates.push({
        key: SurgeConfigKeys.minActiveRiders,
        value: Math.max(0, Math.floor(patch.minActiveRiders)),
        description: 'Min active riders in hex before demand surge',
      });
    }
    if (typeof patch.maxStepUp === 'number') {
      updates.push({
        key: SurgeConfigKeys.maxStepUp,
        value: patch.maxStepUp,
        description: 'Max surge step up per resolve',
      });
    }
    if (typeof patch.maxStepDown === 'number') {
      updates.push({
        key: SurgeConfigKeys.maxStepDown,
        value: patch.maxStepDown,
        description: 'Max surge step down per resolve',
      });
    }
    if (typeof patch.neighborBlend === 'number') {
      updates.push({
        key: SurgeConfigKeys.neighborBlend,
        value: patch.neighborBlend,
        description: 'Neighbor hex blend weight for surge smoothing',
      });
    }

    if (!updates.length) {
      throw new BadRequestException('No surge fields to update');
    }

    await this.configuration.setMany(updates);
    this.fareService.clearSurgeCache();

    const next = this.getState();
    await this.audit.save(
      this.audit.create({
        actorId,
        actorRole: 'admin',
        action: 'surge.config_update',
        targetType: 'configuration',
        targetId: 'surge',
        metadata: { previous, next },
      }),
    );
    this.logger.log(
      `Surge config updated by ${actorId}: override=${next.overrideEnabled} x${next.overrideMultiplier}`,
    );
    return next;
  }

  private readNumber(key: string, fallback: number): number {
    try {
      const value = this.configuration.get<unknown>(key);
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : fallback;
    } catch {
      return fallback;
    }
  }

  private readBool(key: string, fallback: boolean): boolean {
    try {
      const value = this.configuration.get<unknown>(key);
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 1) return true;
      if (value === 'false' || value === 0) return false;
      return fallback;
    } catch {
      return fallback;
    }
  }

  private readZoneMap(): Record<string, number> {
    try {
      const raw = this.configuration.get<unknown>(SurgeConfigKeys.zoneOverrides);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 1) out[k] = n;
      }
      return out;
    } catch {
      return {};
    }
  }
}
