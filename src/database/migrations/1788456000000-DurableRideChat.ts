import { MigrationInterface, QueryRunner } from 'typeorm';

export class DurableRideChat1788456000000 implements MigrationInterface {
  name = 'DurableRideChat1788456000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE ride_messages
      ADD COLUMN "receiverId" uuid,
      ADD COLUMN "senderType" varchar(16),
      ADD COLUMN "clientMessageId" uuid,
      ADD COLUMN "readAt" timestamptz`);
    await queryRunner.query(`UPDATE ride_messages m SET
      "receiverId" = CASE WHEN m."senderId" = r."riderId" THEN r."driverId" ELSE r."riderId" END,
      "senderType" = CASE WHEN m."senderId" = r."riderId" THEN 'rider' ELSE 'driver' END
      FROM rides r WHERE r.id = m."rideId"`);
    await queryRunner.query(`ALTER TABLE ride_messages ADD CONSTRAINT "FK_ride_messages_receiverId"
      FOREIGN KEY ("receiverId") REFERENCES user_accounts(id) ON DELETE CASCADE`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_ride_messages_client"
      ON ride_messages ("rideId", "senderId", "clientMessageId")`);
    await queryRunner.query(`CREATE INDEX "IDX_ride_messages_page"
      ON ride_messages ("rideId", "createdAt" DESC, id DESC)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "IDX_ride_messages_page"');
    await queryRunner.query('DROP INDEX "UQ_ride_messages_client"');
    await queryRunner.query(`ALTER TABLE ride_messages DROP CONSTRAINT "FK_ride_messages_receiverId",
      DROP COLUMN "receiverId", DROP COLUMN "senderType", DROP COLUMN "clientMessageId", DROP COLUMN "readAt"`);
  }
}
