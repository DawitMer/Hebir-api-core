import { MigrationInterface, QueryRunner } from 'typeorm';
import { bootstrappedFromBaseline } from '../migration-utils';

/**
 * Indexes for the queries the ride/dispatch path actually issues, plus the
 * new foreign keys (Postgres does not index the referencing side, so every
 * cascade delete would otherwise sequential-scan the child table).
 *
 * Also drops indexes that synchronize and a migration both created, and the
 * bare rides(status) index that IDX_rides_status_updated already covers.
 */
const INDEXES: Array<[name: string, definition: string]> = [
  // listRidesForRider(): riderId + createdAt DESC.
  ['IDX_rides_rider_created', `ON "rides" ("riderId", "createdAt" DESC)`],
  // getCurrentOffer() and the reaper's live-offer lookup.
  [
    'IDX_rides_offer_driver',
    `ON "rides" ("offerDriverId", "status") WHERE "offerDriverId" IS NOT NULL`,
  ],
  // reapStalledDispatch(): offers past their expiry.
  [
    'IDX_rides_offer_expiry',
    `ON "rides" ("offerExpiresAt") WHERE "status" = 'offered'`,
  ],
  // recoverOrphanedDispatches() and the overdue-search sweep.
  ['IDX_rides_status_requested', `ON "rides" ("status", "requestedAt")`],
  // Driver trip history / active-ride lookups.
  [
    'IDX_rides_driver_created',
    `ON "rides" ("driverId", "createdAt" DESC) WHERE "driverId" IS NOT NULL`,
  ],

  // Ride children (also covers the new ON DELETE CASCADE work).
  [
    'IDX_ride_status_events_ride_changed',
    `ON "ride_status_events" ("rideId", "changedAt" DESC)`,
  ],
  ['IDX_tips_rideId', `ON "tips" ("rideId")`],
  ['IDX_tips_driverId', `ON "tips" ("driverId")`],
  ['IDX_tips_riderId', `ON "tips" ("riderId")`],
  ['IDX_ratings_ratedUser', `ON "ratings" ("ratedUser")`],

  // Money: payout/earnings reporting and payment lookups by owner.
  [
    'IDX_driver_earnings_driver_created',
    `ON "driver_earnings" ("driverId", "createdAt" DESC)`,
  ],
  [
    'IDX_driver_earnings_source',
    `ON "driver_earnings" ("sourceType", "sourceId")`,
  ],
  ['IDX_payments_userId', `ON "payments" ("userId")`],
  [
    'IDX_payments_rideId',
    `ON "payments" ("rideId") WHERE "rideId" IS NOT NULL`,
  ],

  // Driver-owned rows referenced by the new foreign keys.
  ['IDX_vehicles_driverId', `ON "vehicles" ("driverId")`],
  [
    'IDX_driver_expenses_driver_incurred',
    `ON "driver_expenses" ("driverId", "incurredAt" DESC)`,
  ],
  [
    'IDX_driver_verifications_driverId',
    `ON "driver_verifications" ("driverId")`,
  ],
  ['IDX_driver_verifications_status', `ON "driver_verifications" ("status")`],
  [
    'IDX_document_submissions_verification',
    `ON "document_submissions" ("driverVerificationId")`,
  ],
  ['IDX_compliance_alerts_driverId', `ON "compliance_alerts" ("driverId")`],
  ['IDX_payment_events_driverId', `ON "payment_events" ("driverId")`],
  [
    'IDX_subscription_status_history_driver',
    `ON "subscription_status_history" ("driverId", "occurredAt" DESC)`,
  ],
  [
    'IDX_subscription_status_history_event',
    `ON "subscription_status_history" ("paymentEventId") WHERE "paymentEventId" IS NOT NULL`,
  ],

  // Gov / ops audit reads.
  [
    'IDX_gov_access_logs_officer_accessed',
    `ON "gov_access_logs" ("officerId", "accessedAt" DESC)`,
  ],
  ['IDX_incidents_reporterId', `ON "incidents" ("reporterId")`],
  [
    'IDX_incidents_rideId',
    `ON "incidents" ("rideId") WHERE "rideId" IS NOT NULL`,
  ],
  [
    'IDX_incidents_assignedToId',
    `ON "incidents" ("assignedToId") WHERE "assignedToId" IS NOT NULL`,
  ],
  [
    'IDX_incidents_relatedUserId',
    `ON "incidents" ("relatedUserId") WHERE "relatedUserId" IS NOT NULL`,
  ],

  // Matching pool.
  ['IDX_trips_driverId', `ON "trips" ("driverId")`],
  ['IDX_rider_requests_riderId', `ON "rider_requests" ("riderId")`],
  ['IDX_bookings_tripId', `ON "bookings" ("tripId")`],
  ['IDX_bookings_riderRequestId', `ON "bookings" ("riderRequestId")`],

  // Degraded dispatch fallback: latest sample per driver inside a lat/lng box.
  [
    'IDX_driver_location_history_recorded',
    `ON "driver_location_history" ("recordedAt" DESC)`,
  ],
];

/** Duplicates left behind by synchronize running alongside migrations. */
const REDUNDANT_INDEXES = [
  'IDX_e9cb5cce5451da8329a855052f', // driver_location_history(driverId, recordedAt) — dup of _driver_recorded
  'IDX_5602596fc4f0b1fb5b5eb14ab3', // incidents(caseNumber) — dup of IDX_incidents_caseNumber
  'IDX_c25bc63d248ca90e8dcc1d92d0', // refresh_tokens(tokenHash) — dup of IDX_refresh_tokens_tokenHash
  'IDX_610102b60fea1455310ccd299d', // refresh_tokens(userId) — dup of IDX_refresh_tokens_userId
  'IDX_87b9253c85be51e3785d3653a8', // rides(status) — prefix of IDX_rides_status_updated
];

export class IndexRideHotPaths1786365200000 implements MigrationInterface {
  name = 'IndexRideHotPaths1786365200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await bootstrappedFromBaseline(queryRunner)) return; // folded into InitialSchema baseline
    for (const [name, definition] of INDEXES) {
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "${name}" ${definition}`,
      );
    }
    for (const name of REDUNDANT_INDEXES) {
      await queryRunner.query(`DROP INDEX IF EXISTS "${name}"`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [name] of [...INDEXES].reverse()) {
      await queryRunner.query(`DROP INDEX IF EXISTS "${name}"`);
    }
    // Redundant indexes are not recreated; the surviving equivalents cover them.
  }
}
