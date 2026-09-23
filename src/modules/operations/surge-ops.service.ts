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
import {
  ADDIS_MARKET_ZONES,
  expandNamedZoneOverrides,
  h3CellsForMarketZone,
  marketZoneById,
} from '../matching/geo/addis-market-zones';

export const SurgeConfigKeys = {
  overrideEnabled: 'surge_override_enabled',
  overrideMultiplier: 'surge_override_multiplier',
  zoneOverrides: 'surge_zone_overrides',
  namedZoneOverrides: 'surge_named_zone_overrides',
  maxMultiplier: 'surge_max_multiplier',
  minActiveRiders: 'surge_min_active_riders',
  maxStepUp: 'surge_max_step_up',
  maxStepDown: 'surge_max_step_down',
  neighborBlend: 'surge_neighbor_blend',
} as const;

export interface SurgeMarketZoneView {
  id: string;
  name: string;
  nameAm: string;
  lat: number;
  lng: number;
  ring: number;
  /** Forced multiplier when set (>1). 1 = follow live hex demand. */
  multiplier: number;
  cellCount: number;
}

export interface SurgeOpsState {
  /**
   * When true, zone/named overrides apply. Hexes without an override follow
   * live demand — never a silent city-wide force unless overrideMultiplier > 1
   * and no named/hex map is set (legacy emergency).
   */
  overrideEnabled: boolean;
  /** Legacy city-wide force. Prefer named zones. */
  overrideMultiplier: number;
  /** Expanded H3 cell → multiplier (authoritative for fare resolve). */
  zoneOverrides: Record<string, number>;
  /** Named Addis market zone → multiplier (ops UI source of truth). */
  namedZoneOverrides: Record<string, number>;
  marketZones: SurgeMarketZoneView[];
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
    const namedZoneOverrides = this.readNamedZoneMap();
    const zoneOverrides = this.readZoneMap();
    return {
      overrideEnabled: this.readBool(SurgeConfigKeys.overrideEnabled, false),
      overrideMultiplier: this.readNumber(
        SurgeConfigKeys.overrideMultiplier,
        1,
      ),
      zoneOverrides,
      namedZoneOverrides,
      marketZones: ADDIS_MARKET_ZONES.map((z) => {
        const multiplier = Number(namedZoneOverrides[z.id]) || 1;
        return {
          id: z.id,
          name: z.name,
          nameAm: z.nameAm,
          lat: z.lat,
          lng: z.lng,
          ring: z.ring,
          multiplier: multiplier < 1 ? 1 : multiplier,
          cellCount: h3CellsForMarketZone(z).length,
        };
      }),
      maxMultiplier: this.readNumber(SurgeConfigKeys.maxMultiplier, 2.5),
      minActiveRiders: this.readNumber(SurgeConfigKeys.minActiveRiders, 2),
      maxStepUp: this.readNumber(SurgeConfigKeys.maxStepUp, 0.2),
      maxStepDown: this.readNumber(SurgeConfigKeys.maxStepDown, 0.3),
      neighborBlend: this.readNumber(SurgeConfigKeys.neighborBlend, 0.35),
    };
  }

  /**
   * Resolve ops override for a pickup hex.
   * - Off → live demand
   * - Hex listed in zoneOverrides → forced
   * - Named/hex map non-empty but this hex missing → live demand (not global)
   * - Empty map + global > 1 → legacy city-wide
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
    const hasZoneMap =
      Object.keys(state.zoneOverrides).length > 0 ||
      Object.keys(state.namedZoneOverrides).some(
        (id) => Number(state.namedZoneOverrides[id]) > 1.001,
      );
    if (hasZoneMap) return null;
    const g = Number(state.overrideMultiplier);
    if (!Number.isFinite(g) || g <= 1.001) return null;
    return Math.min(Math.max(1, g), max);
  }

  async update(
    actorId: string,
    patch: Partial<{
      overrideEnabled: boolean;
      overrideMultiplier: number;
      zoneOverrides: Record<string, number>;
      namedZoneOverrides: Record<string, number>;
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
        description:
          'Legacy city-wide force (avoid — use named Addis zones instead)',
      });
    }
    if (patch.clearZoneOverrides) {
      updates.push({
        key: SurgeConfigKeys.namedZoneOverrides,
        value: {},
        description: 'Named Addis market zone surge multipliers',
      });
      updates.push({
        key: SurgeConfigKeys.zoneOverrides,
        value: {},
        description: 'Per-hex forced surge multipliers (H3 cell id → multiplier)',
      });
    } else if (
      patch.namedZoneOverrides &&
      typeof patch.namedZoneOverrides === 'object'
    ) {
      const cleaned: Record<string, number> = {
        ...previous.namedZoneOverrides,
      };
      for (const [zoneId, raw] of Object.entries(patch.namedZoneOverrides)) {
        const id = String(zoneId).trim();
        if (!id || !marketZoneById(id)) {
          if (id && !marketZoneById(id)) {
            throw new BadRequestException(`Unknown market zone: ${id}`);
          }
          continue;
        }
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 1.001) {
          delete cleaned[id];
        } else {
          cleaned[id] = Math.round(n * 100) / 100;
        }
      }
      const expanded = expandNamedZoneOverrides(cleaned);
      updates.push({
        key: SurgeConfigKeys.namedZoneOverrides,
        value: cleaned,
        description: 'Named Addis market zone surge multipliers',
      });
      updates.push({
        key: SurgeConfigKeys.zoneOverrides,
        value: expanded,
        description: 'H3 cells expanded from named Addis market zones',
      });
      // Turning on named surges implies override mode.
      if (Object.keys(cleaned).length > 0) {
        updates.push({
          key: SurgeConfigKeys.overrideEnabled,
          value: true,
          description: 'Ops manual surge override master switch',
        });
      }
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
        description: 'Per-hex forced surge multipliers (H3 cell id → multiplier)',
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

    // Deduplicate by key (last wins) so named expand + overrideEnabled coalesce.
    const byKey = new Map<string, (typeof updates)[number]>();
    for (const u of updates) byKey.set(u.key, u);
    await this.configuration.setMany([...byKey.values()]);
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
      `Surge config updated by ${actorId}: named=${Object.keys(next.namedZoneOverrides).length} hex=${Object.keys(next.zoneOverrides).length}`,
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

  private readNamedZoneMap(): Record<string, number> {
    try {
      const raw = this.configuration.get<unknown>(
        SurgeConfigKeys.namedZoneOverrides,
      );
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!marketZoneById(k)) continue;
        const n = Number(v);
        if (Number.isFinite(n) && n > 1.001) out[k] = n;
      }
      return out;
    } catch {
      return {};
    }
  }
}
