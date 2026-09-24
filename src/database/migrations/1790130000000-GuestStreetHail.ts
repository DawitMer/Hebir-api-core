import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Guest street-hail: rides may exist without a registered rider account.
 * Guest contact lives on the ride row; verification still uses startCodeHash.
 */
export class GuestStreetHail1790130000000 implements MigrationInterface {
  name = 'GuestStreetHail1790130000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "rides"
        ALTER COLUMN "riderId" DROP NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "rides"
        ADD COLUMN IF NOT EXISTS "isGuest" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "rides"
        ADD COLUMN IF NOT EXISTS "isStreetHail" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "rides"
        ADD COLUMN IF NOT EXISTS "guestPhoneE164" varchar(20) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "rides"
        ADD COLUMN IF NOT EXISTS "guestStartSmsSentAt" TIMESTAMPTZ NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "rides"
        ADD COLUMN IF NOT EXISTS "guestFareSmsSentAt" TIMESTAMPTZ NULL
    `);

    // One live ride per registered rider (null riderId excluded).
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_rides_one_active_per_rider"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_rides_one_active_per_rider"
        ON "rides" ("riderId")
        WHERE "riderId" IS NOT NULL
          AND "status" IN (
            'requested', 'searching', 'offered', 'matched',
            'accepted', 'arriving', 'in_progress'
          )
    `);

    // One live guest hail per phone number.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_rides_one_active_per_guest_phone"
        ON "rides" ("guestPhoneE164")
        WHERE "guestPhoneE164" IS NOT NULL
          AND "status" IN (
            'requested', 'searching', 'offered', 'matched',
            'accepted', 'arriving', 'in_progress'
          )
    `);

    // Payment rows for guest fares have no user account.
    await queryRunner.query(`
      ALTER TABLE "payments"
        ALTER COLUMN "userId" DROP NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_rides_one_active_per_guest_phone"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_rides_one_active_per_rider"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_rides_one_active_per_rider"
        ON "rides" ("riderId")
        WHERE "status" IN (
          'requested', 'searching', 'offered', 'matched',
          'accepted', 'arriving', 'in_progress'
        )
    `);
    await queryRunner.query(`
      ALTER TABLE "rides"
        DROP COLUMN IF EXISTS "guestFareSmsSentAt",
        DROP COLUMN IF EXISTS "guestStartSmsSentAt",
        DROP COLUMN IF EXISTS "guestPhoneE164",
        DROP COLUMN IF EXISTS "isStreetHail",
        DROP COLUMN IF EXISTS "isGuest"
    `);
    await queryRunner.query(`
      ALTER TABLE "rides"
        ALTER COLUMN "riderId" SET NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "payments"
        ALTER COLUMN "userId" SET NOT NULL
    `);
  }
}
