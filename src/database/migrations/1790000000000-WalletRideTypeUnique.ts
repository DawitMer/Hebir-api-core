import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Allow one wallet credit per (ride, type) so advertising and promotion
 * reimbursements can both land on the same trip without colliding on
 * UQ_wallet_ride.
 */
export class WalletRideTypeUnique1790000000000 implements MigrationInterface {
  name = 'WalletRideTypeUnique1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_wallet_ride"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_wallet_ride_type" ON "driver_wallet_entries" ("rideId", "type") WHERE "rideId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_wallet_ride_type"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_wallet_ride" ON "driver_wallet_entries" ("rideId") WHERE "rideId" IS NOT NULL`,
    );
  }
}
