import { MigrationInterface, QueryRunner } from 'typeorm';

export class EnsureCoreIndexesAndConstraints1789700000000 implements MigrationInterface {
  name = 'EnsureCoreIndexesAndConstraints1789700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Core Partial Unique Constraints (Concurrency Boundaries)
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_rides_one_active_per_rider"
      ON "rides" ("riderId")
      WHERE "status" IN (
        'requested',
        'searching',
        'offered',
        'matched',
        'accepted',
        'arriving',
        'in_progress'
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_rides_one_active_per_driver"
      ON "rides" ("driverId")
      WHERE "driverId" IS NOT NULL
        AND "status" IN (
          'matched',
          'accepted',
          'arriving',
          'in_progress'
        )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_vehicles_driverId"
      ON "vehicles" ("driverId")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_driver_subscriptions_driverId"
      ON "driver_subscriptions" ("driverId")
    `);

    // 2. High Performance Query Indexes for Dispatch & Active Ride Recovery
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rides_status_updated"
      ON "rides" ("status", "updatedAt" DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rides_riderId_createdAt"
      ON "rides" ("riderId", "createdAt" DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rides_driverId_status"
      ON "rides" ("driverId", "status")
      WHERE "driverId" IS NOT NULL
    `);

    // 3. Relational Foreign Key Constraints
    const foreignKeys = [
      {
        table: 'rides',
        constraint: 'FK_rides_riderId',
        column: 'riderId',
        refTable: 'user_accounts',
        refColumn: 'id',
        onDelete: 'RESTRICT',
      },
      {
        table: 'rides',
        constraint: 'FK_rides_driverId',
        column: 'driverId',
        refTable: 'user_accounts',
        refColumn: 'id',
        onDelete: 'SET NULL',
      },
      {
        table: 'fares',
        constraint: 'FK_fares_rideId',
        column: 'rideId',
        refTable: 'rides',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'ride_messages',
        constraint: 'FK_ride_messages_rideId',
        column: 'rideId',
        refTable: 'rides',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'ride_messages',
        constraint: 'FK_ride_messages_senderId',
        column: 'senderId',
        refTable: 'user_accounts',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'ride_status_events',
        constraint: 'FK_ride_status_events_rideId',
        column: 'rideId',
        refTable: 'rides',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'driver_profiles',
        constraint: 'FK_driver_profiles_userId',
        column: 'userId',
        refTable: 'user_accounts',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'vehicles',
        constraint: 'FK_vehicles_driverId',
        column: 'driverId',
        refTable: 'user_accounts',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
      {
        table: 'refresh_tokens',
        constraint: 'FK_refresh_tokens_userId',
        column: 'userId',
        refTable: 'user_accounts',
        refColumn: 'id',
        onDelete: 'CASCADE',
      },
    ];

    for (const fk of foreignKeys) {
      const exists: Array<{ count: string }> = await queryRunner.query(`
        SELECT count(*)::text AS count
        FROM information_schema.table_constraints
        WHERE constraint_name = '${fk.constraint}'
          AND table_schema = 'public'
      `);
      if (Number(exists[0]?.count ?? 0) === 0) {
        await queryRunner.query(`
          ALTER TABLE "${fk.table}"
          ADD CONSTRAINT "${fk.constraint}"
          FOREIGN KEY ("${fk.column}")
          REFERENCES "${fk.refTable}"("${fk.refColumn}")
          ON DELETE ${fk.onDelete}
        `);
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const constraints = [
      { table: 'refresh_tokens', name: 'FK_refresh_tokens_userId' },
      { table: 'vehicles', name: 'FK_vehicles_driverId' },
      { table: 'driver_profiles', name: 'FK_driver_profiles_userId' },
      { table: 'ride_status_events', name: 'FK_ride_status_events_rideId' },
      { table: 'ride_messages', name: 'FK_ride_messages_senderId' },
      { table: 'ride_messages', name: 'FK_ride_messages_rideId' },
      { table: 'fares', name: 'FK_fares_rideId' },
      { table: 'rides', name: 'FK_rides_driverId' },
      { table: 'rides', name: 'FK_rides_riderId' },
    ];
    for (const c of constraints) {
      await queryRunner.query(
        `ALTER TABLE "${c.table}" DROP CONSTRAINT IF EXISTS "${c.name}"`,
      );
    }
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_rides_driverId_status"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_rides_riderId_createdAt"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_rides_status_updated"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_driver_subscriptions_driverId"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_vehicles_driverId"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_rides_one_active_per_driver"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_rides_one_active_per_rider"`,
    );
  }
}
