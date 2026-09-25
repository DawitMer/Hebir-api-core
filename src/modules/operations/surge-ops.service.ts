import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { isValidCell } from 'h3-js';
import { ConfigurationService } from '../subscription/configuration.service';
import { AuditTrail } from '../kyc/entities/audit-trail.entity';
import { FareService } from '../fare/fare.service';
import {
  ADDIS_MARKET_ZONES,
  expandNamedZoneOverrides,
  h3CellsForMarketZone,
  marketZoneById,
} from '../matching/geo/addis-market-zones';
import {
  H3_SURGE_RESOLUTION,
  zoneBoundary,
  zoneCenter,
  zoneIdFor,
} from '../matching/geo/geo.util';

export const SurgeConfigKeys = {
  overrideEnabled: 'surge_override_enabled',
  overrideMultiplier: 'surge_override_multiplier',
  /** Merged H3 → multiplier (named expand + hex). Kept for fare.service. */
  zoneOverrides: 'surge_zone_overrides',
  /** Manual per-hex force (H3 cell id → multiplier). Survives named-zone saves. */
  hexOverrides: 'surge_hex_overrides',
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

export interface SurgeHexCellView {
  zoneId: string;
  lat: number;
  lng: number;
  multiplier: number;
  boundary: Array<{ lat: number; lng: number }>;
}

export interface SurgeOpsState {
  /**
   * When true, zone/named overrides apply. Hexes without an override follow
   * live demand — never a silent city-wide force unless overrideMultiplier > 1
   * and no named/hex map is set (legacy emergency).
   */
  overrideEnabled: boolean;
  /** Legacy city-wide force. Prefer named zones or per-hex. */
  overrideMultiplier: number;
  /** Merged H3 cell → multiplier (authoritative for fare / demand heat). */
  zoneOverrides: Record<string, number>;
  /** Manual per-hex force only (ops UI hex section). */
  hexOverrides: Record<string, number>;
  /** Named Addis market zone → multiplier (ops UI neighborhood section). */
  namedZoneOverrides: Record<string, number>;
  marketZones: SurgeMarketZoneView[];
  /** Active manual hex rows for ops UI. */
  hexCells: SurgeHexCellView[];
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
    const hexOverrides = this.readHexMap();
    // Named expand first; manual hex wins on the same cell.
    const fromNamed = expandNamedZoneOverrides(namedZoneOverrides);
    const zoneOverrides = { ...fromNamed, ...hexOverrides };
    return {
      overrideEnabled: this.readBool(SurgeConfigKeys.overrideEnabled, false),
      overrideMultiplier: this.readNumber(
        SurgeConfigKeys.overrideMultiplier,
        1,
      ),
      zoneOverrides,
      hexOverrides,
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
      hexCells: Object.entries(hexOverrides).map(([zoneId, multiplier]) => {
        const center = zoneCenter(zoneId);
        return {
          zoneId,
          lat: center?.lat ?? 0,
          lng: center?.lng ?? 0,
          multiplier,
          boundary: zoneBoundary(zoneId),
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

  /** Look up H3 cell for a map pin or validate an existing cell id. */
  resolveCell(input: {
    lat?: number;
    lng?: number;
    zoneId?: string;
  }): SurgeHexCellView {
    let zoneId = String(input.zoneId ?? '').trim();
    if (!zoneId) {
      const lat = Number(input.lat);
      const lng = Number(input.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new BadRequestException('Provide zoneId or lat+lng');
      }
      zoneId = zoneIdFor({ lat, lng }, H3_SURGE_RESOLUTION);
    }
    if (!isValidCell(zoneId)) {
      throw new BadRequestException(`Invalid H3 cell id: ${zoneId}`);
    }
    const center = zoneCenter(zoneId);
    if (!center) {
      throw new BadRequestException(`Could not resolve cell: ${zoneId}`);
    }
    const state = this.getState();
    const multiplier = Number(state.zoneOverrides[zoneId]) || 1;
    return {
      zoneId,
      lat: center.lat,
      lng: center.lng,
      multiplier: multiplier < 1 ? 1 : multiplier,
      boundary: zoneBoundary(zoneId),
    };
  }

  async update(
    actorId: string,
    patch: Partial<{
      overrideEnabled: boolean;
      overrideMultiplier: number;
      zoneOverrides: Record<string, number>;
      hexOverrides: Record<string, number>;
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
          'Legacy city-wide force (avoid — use named Addis zones or hex cells)',
      });
    }

    let nextNamed = { ...previous.namedZoneOverrides };
    let nextHex = { ...previous.hexOverrides };
    let mapsTouched = false;

    if (patch.clearZoneOverrides) {
      nextNamed = {};
      nextHex = {};
      mapsTouched = true;
      updates.push({
        key: SurgeConfigKeys.namedZoneOverrides,
        value: {},
        description: 'Named Addis market zone surge multipliers',
      });
      updates.push({
        key: SurgeConfigKeys.hexOverrides,
        value: {},
        description: 'Manual per-hex forced surge multipliers',
      });
      updates.push({
        key: SurgeConfigKeys.zoneOverrides,
        value: {},
        description: 'Merged H3 surge multipliers (named + hex)',
      });
    }

    if (
      !patch.clearZoneOverrides &&
      patch.namedZoneOverrides &&
      typeof patch.namedZoneOverrides === 'object'
    ) {
      mapsTouched = true;
      // Full snapshot from ops UI — omitted zones return to live demand.
      nextNamed = {};
      for (const [zoneId, raw] of Object.entries(patch.namedZoneOverrides)) {
        const id = String(zoneId).trim();
        if (!id || !marketZoneById(id)) {
          if (id && !marketZoneById(id)) {
            throw new BadRequestException(`Unknown market zone: ${id}`);
          }
          continue;
        }
        const n = Number(raw);
        if (Number.isFinite(n) && n > 1.001) {
          nextNamed[id] = Math.round(n * 100) / 100;
        }
      }
      updates.push({
        key: SurgeConfigKeys.namedZoneOverrides,
        value: nextNamed,
        description: 'Named Addis market zone surge multipliers',
      });
    }

    // Manual hex map — preferred field. zoneOverrides patch aliases here so
    // older clients still work, without wiping named-zone expansions.
    const hexPatch =
      !patch.clearZoneOverrides &&
      ((patch.hexOverrides && typeof patch.hexOverrides === 'object'
        ? patch.hexOverrides
        : null) ||
        (patch.zoneOverrides &&
        typeof patch.zoneOverrides === 'object' &&
        !patch.namedZoneOverrides
          ? patch.zoneOverrides
          : null));

    if (hexPatch) {
      mapsTouched = true;
      // Full snapshot — omitted cells return to live / named-only demand.
      nextHex = {};
      for (const [zoneId, raw] of Object.entries(hexPatch)) {
        const id = String(zoneId).trim();
        if (!id) continue;
        if (!isValidCell(id)) {
          throw new BadRequestException(`Invalid H3 cell id: ${id}`);
        }
        const n = Number(raw);
        if (Number.isFinite(n) && n > 1.001) {
          nextHex[id] = Math.round(n * 100) / 100;
        }
      }
      updates.push({
        key: SurgeConfigKeys.hexOverrides,
        value: nextHex,
        description: 'Manual per-hex forced surge multipliers',
      });
    }

    if (mapsTouched && !patch.clearZoneOverrides) {
      const merged = {
        ...expandNamedZoneOverrides(nextNamed),
        ...nextHex,
      };
      updates.push({
        key: SurgeConfigKeys.zoneOverrides,
        value: merged,
        description: 'Merged H3 surge multipliers (named + hex)',
      });
      if (Object.keys(nextNamed).length > 0 || Object.keys(nextHex).length > 0) {
        updates.push({
          key: SurgeConfigKeys.overrideEnabled,
          value: true,
          description: 'Ops manual surge override master switch',
        });
      }
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
      `Surge config updated by ${actorId}: named=${Object.keys(next.namedZoneOverrides).length} hex=${Object.keys(next.hexOverrides).length} merged=${Object.keys(next.zoneOverrides).length}`,
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

  private readHexMap(): Record<string, number> {
    try {
      const raw = this.configuration.get<unknown>(SurgeConfigKeys.hexOverrides);
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (!isValidCell(k)) continue;
          const n = Number(v);
          if (Number.isFinite(n) && n > 1.001) out[k] = n;
        }
        if (Object.keys(out).length > 0) return out;
      }
    } catch {
      // fall through — migrate from legacy merged zoneOverrides
    }
    // Legacy DB only had surge_zone_overrides (named expand + any manual).
    // Keep cells that are not explained by the current named expand.
    try {
      const namedExpand = expandNamedZoneOverrides(this.readNamedZoneMap());
      const legacy = this.readZoneMap();
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(legacy)) {
        if (!isValidCell(k) || v <= 1.001) continue;
        const fromNamed = Number(namedExpand[k]);
        if (Number.isFinite(fromNamed) && Math.abs(fromNamed - v) < 0.001) {
          continue;
        }
        out[k] = v;
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
