import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CONFIG_DEFAULTS,
  Configuration,
} from './entities/configuration.entity';
import { FARE_RATE_DEFAULTS, FareRateKeys } from '../fare/fare-rates';

/**
 * Single source of truth for operational parameters (blueprint section 10).
 * None of these values may be hardcoded in application logic; operations
 * must be able to change them without a release.
 */
@Injectable()
export class ConfigurationService implements OnModuleInit {
  private readonly logger = new Logger(ConfigurationService.name);
  private cache = new Map<string, unknown>();

  constructor(
    @InjectRepository(Configuration)
    private readonly repo: Repository<Configuration>,
  ) {}

  async onModuleInit() {
    await this.repo.manager.transaction(async (em) => {
      // Serializes first boot across API replicas. Never reprice existing rows.
      await em.query('SELECT pg_advisory_xact_lock(1788456400)');
      const scoped = new ConfigurationService(em.getRepository(Configuration));
      await scoped.migrateLegacyFareKeys();
      await scoped.seedDefaults();
    });
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
    const perKm = await this.repo.findOne({
      where: { key: 'fare_per_km_etb' },
    });
    if (!perMeter && perKm) {
      const km = Number(perKm.value);
      await this.repo.save(
        this.repo.create({
          key: 'fare_per_meter_etb',
          value: Number.isFinite(km)
            ? km / 1000
            : FARE_RATE_DEFAULTS[FareRateKeys.perMeterEtb],
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
          value: fee?.value ?? FARE_RATE_DEFAULTS[FareRateKeys.minimumEtb],
          description: 'Minimum fare (ETB) before surge',
        }),
      );
    }
  }

  @Interval(30000)
  async refreshReplicaCache() {
    try {
      await this.refreshCache();
    } catch {
      this.logger.warn(
        'Configuration refresh failed; retaining last complete snapshot',
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
    await this.setMany([{ key, value, description }]);
  }

  async setMany(
    updates: Array<{ key: string; value: unknown; description?: string }>,
  ) {
    if (!updates.length) return;
    await this.repo.manager.transaction(async (em) => {
      await em.query('SELECT pg_advisory_xact_lock(1788456400)');
      for (const update of updates) {
        await em.getRepository(Configuration).upsert(update, ['key']);
      }
    });
    await this.refreshCache();
  }

  async all(): Promise<Record<string, unknown>> {
    return Object.fromEntries(this.cache.entries());
  }
}
