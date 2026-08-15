import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CONFIG_DEFAULTS, Configuration } from './entities/configuration.entity';

/**
 * Single source of truth for operational parameters (blueprint section 10).
 * None of these values may be hardcoded in application logic; operations
 * must be able to change them without a release.
 */
@Injectable()
export class ConfigurationService implements OnModuleInit {
  private cache = new Map<string, unknown>();

  constructor(
    @InjectRepository(Configuration)
    private readonly repo: Repository<Configuration>,
  ) {}

  async onModuleInit() {
    await this.seedDefaults();
    await this.migrateLegacyFareKeys();
    await this.refreshCache();
  }

  private async seedDefaults() {
    for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
      const existing = await this.repo.findOne({ where: { key } });
      if (!existing) {
        await this.repo.save(this.repo.create({ key, value }));
      }
    }
  }

  /**
   * Copy old fare_base / fare_per_km into the separated initial-fee /
   * per-meter keys when those rows were never written.
   */
  private async migrateLegacyFareKeys() {
    const initial = await this.repo.findOne({
      where: { key: 'fare_initial_fee_etb' },
    });
    const base = await this.repo.findOne({ where: { key: 'fare_base_etb' } });
    if (!initial && base) {
      await this.repo.save(
        this.repo.create({
          key: 'fare_initial_fee_etb',
          value: base.value,
          description: 'Flat initial fee (ETB) — migrated from fare_base_etb',
        }),
      );
    }

    const perMeter = await this.repo.findOne({
      where: { key: 'fare_per_meter_etb' },
    });
    const perKm = await this.repo.findOne({ where: { key: 'fare_per_km_etb' } });
    if (!perMeter && perKm) {
      const km = Number(perKm.value);
      await this.repo.save(
        this.repo.create({
          key: 'fare_per_meter_etb',
          value: Number.isFinite(km) ? km / 1000 : 0.008,
          description: 'ETB per meter — migrated from fare_per_km_etb / 1000',
        }),
      );
    }

    const minimum = await this.repo.findOne({
      where: { key: 'fare_minimum_etb' },
    });
    if (!minimum) {
      const fee =
        (await this.repo.findOne({ where: { key: 'fare_initial_fee_etb' } })) ??
        base;
      await this.repo.save(
        this.repo.create({
          key: 'fare_minimum_etb',
          value: fee?.value ?? 20,
          description: 'Minimum fare (ETB) before surge',
        }),
      );
    }
  }

  async refreshCache() {
    const rows = await this.repo.find();
    this.cache = new Map(rows.map((row) => [row.key, row.value]));
  }

  get<T = unknown>(key: string): T {
    if (!this.cache.has(key)) {
      if (key in CONFIG_DEFAULTS) {
        return CONFIG_DEFAULTS[key] as T;
      }
      throw new Error(`Unknown configuration key: ${key}`);
    }
    return this.cache.get(key) as T;
  }

  async set(key: string, value: unknown, description?: string) {
    const existing = await this.repo.findOne({ where: { key } });
    if (existing) {
      existing.value = value;
      if (description) existing.description = description;
      await this.repo.save(existing);
    } else {
      await this.repo.save(this.repo.create({ key, value, description }));
    }
    await this.refreshCache();
  }

  async all(): Promise<Record<string, unknown>> {
    return Object.fromEntries(this.cache.entries());
  }
}
