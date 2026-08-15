import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Baseline schema for fresh installs.
 *
 * Historically the base tables were created by TypeORM synchronize and every
 * migration in this folder assumed they already existed, so a brand-new
 * database could never bootstrap. This migration recreates the full schema
 * (captured with pg_dump from a fully migrated database) when the database is
 * empty, and records that fact in the `schema_bootstrap` marker table so the
 * legacy migrations below know to skip themselves (their changes are already
 * part of this baseline).
 *
 * On databases that predate this migration the `user_accounts` table already
 * exists, so this is a no-op and the legacy migrations behave exactly as
 * before.
 */
export class InitialSchema1786363000000 implements MigrationInterface {
  name = 'InitialSchema1786363000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const existing: Array<{ t: string | null }> = await queryRunner.query(
      "SELECT to_regclass('public.user_accounts') AS t",
    );
    if (existing[0]?.t) {
      // Pre-baseline database — schema already exists via synchronize + legacy migrations.
      return;
    }

    await queryRunner.query(BASELINE_SQL);
    await queryRunner.query(
      'CREATE TABLE "schema_bootstrap" ("id" integer PRIMARY KEY, "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
    await queryRunner.query('INSERT INTO "schema_bootstrap" ("id") VALUES (1)');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Only meaningful for fresh installs bootstrapped by this migration.
    const marker: Array<{ t: string | null }> = await queryRunner.query(
      "SELECT to_regclass('public.schema_bootstrap') AS t",
    );
    if (!marker[0]?.t) return;
    await queryRunner.query('DROP SCHEMA public CASCADE');
    await queryRunner.query('CREATE SCHEMA public');
  }
}

const BASELINE_SQL = `
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;
COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';
CREATE TYPE public.bookings_status_enum AS ENUM (
    'held',
    'confirmed',
    'declined',
    'expired'
);
CREATE TYPE public.compliance_alerts_severity_enum AS ENUM (
    'low',
    'medium',
    'high',
    'critical'
);
CREATE TYPE public.compliance_alerts_status_enum AS ENUM (
    'open',
    'acknowledged',
    'resolved'
);
CREATE TYPE public.document_submissions_category_enum AS ENUM (
    'driver',
    'vehicle'
);
CREATE TYPE public.document_submissions_status_enum AS ENUM (
    'queued',
    'under_review',
    'approved',
    'rejected',
    'resubmission_requested'
);
CREATE TYPE public.driver_earnings_payoutstatus_enum AS ENUM (
    'pending',
    'paid',
    'failed'
);
CREATE TYPE public.driver_earnings_sourcetype_enum AS ENUM (
    'ride',
    'tip'
);
CREATE TYPE public.driver_profiles_status_enum AS ENUM (
    'offline',
    'online',
    'on_trip',
    'reserved'
);
CREATE TYPE public.driver_subscriptions_state_enum AS ENUM (
    'inactive',
    'active',
    'past_due',
    'suspended'
);
CREATE TYPE public.driver_verifications_status_enum AS ENUM (
    'pending',
    'in_review',
    'escalated',
    'approved',
    'rejected'
);
CREATE TYPE public.incidents_priority_enum AS ENUM (
    'critical',
    'high',
    'medium',
    'low'
);
CREATE TYPE public.incidents_status_enum AS ENUM (
    'open',
    'assigned',
    'resolved'
);
CREATE TYPE public.incidents_type_enum AS ENUM (
    'sos',
    'safetyAlert',
    'rideDispute',
    'paymentFailure',
    'driverOffline',
    'surgeIssue',
    'other'
);
CREATE TYPE public.payment_events_provider_enum AS ENUM (
    'chapa',
    'telebirr',
    'paystack'
);
CREATE TYPE public.payments_status_enum AS ENUM (
    'pending',
    'succeeded',
    'failed'
);
CREATE TYPE public.payments_type_enum AS ENUM (
    'subscription',
    'fare',
    'tip'
);
CREATE TYPE public.ride_status_events_status_enum AS ENUM (
    'requested',
    'searching',
    'offered',
    'matched',
    'accepted',
    'arriving',
    'in_progress',
    'completed',
    'cancelled',
    'unmatched'
);
CREATE TYPE public.rider_requests_status_enum AS ENUM (
    'queued',
    'matched',
    'cancelled'
);
CREATE TYPE public.rides_status_enum AS ENUM (
    'requested',
    'searching',
    'offered',
    'matched',
    'accepted',
    'arriving',
    'in_progress',
    'completed',
    'cancelled',
    'unmatched'
);
CREATE TYPE public.subscription_status_history_fromstate_enum AS ENUM (
    'inactive',
    'active',
    'past_due',
    'suspended'
);
CREATE TYPE public.subscription_status_history_tostate_enum AS ENUM (
    'inactive',
    'active',
    'past_due',
    'suspended'
);
CREATE TYPE public.tips_status_enum AS ENUM (
    'pending',
    'succeeded',
    'failed'
);
CREATE TYPE public.user_accounts_roles_enum AS ENUM (
    'rider',
    'driver',
    'admin',
    'gov_officer'
);
CREATE TYPE public.user_accounts_standing_enum AS ENUM (
    'good',
    'flagged',
    'banned'
);
CREATE TABLE public.audit_trails (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "actorId" uuid NOT NULL,
    "actorRole" character varying NOT NULL,
    action character varying NOT NULL,
    "targetType" character varying NOT NULL,
    "targetId" character varying NOT NULL,
    metadata jsonb,
    "occurredAt" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.bookings (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "tripId" uuid NOT NULL,
    "riderRequestId" uuid NOT NULL,
    seats integer NOT NULL,
    "agreedPricePerSeat" numeric(10,2) NOT NULL,
    "calculatedFare" numeric(10,2) NOT NULL,
    status public.bookings_status_enum DEFAULT 'held'::public.bookings_status_enum NOT NULL,
    "holdExpiresAt" timestamp with time zone NOT NULL,
    "driverConfirmed" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.compliance_alerts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "driverId" uuid NOT NULL,
    title character varying NOT NULL,
    description character varying NOT NULL,
    severity public.compliance_alerts_severity_enum NOT NULL,
    status public.compliance_alerts_status_enum DEFAULT 'open'::public.compliance_alerts_status_enum NOT NULL,
    "raisedAt" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.configuration (
    key character varying NOT NULL,
    value jsonb NOT NULL,
    description character varying,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.document_submissions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "driverVerificationId" uuid NOT NULL,
    "documentType" character varying NOT NULL,
    category public.document_submissions_category_enum NOT NULL,
    "storageKey" character varying NOT NULL,
    status public.document_submissions_status_enum DEFAULT 'queued'::public.document_submissions_status_enum NOT NULL,
    "expiresAt" timestamp with time zone,
    "submittedAt" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.driver_earnings (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "driverId" uuid NOT NULL,
    "sourceType" public.driver_earnings_sourcetype_enum NOT NULL,
    "sourceId" uuid NOT NULL,
    amount numeric(10,2) NOT NULL,
    "payoutStatus" public.driver_earnings_payoutstatus_enum DEFAULT 'pending'::public.driver_earnings_payoutstatus_enum NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.driver_expenses (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "driverId" uuid NOT NULL,
    category character varying NOT NULL,
    amount numeric(10,2) NOT NULL,
    description character varying,
    "incurredAt" timestamp with time zone NOT NULL,
    "submittedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "reviewStatus" character varying(32)
);
CREATE TABLE public.driver_location_history (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "driverId" uuid NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    heading double precision,
    speed double precision,
    "recordedAt" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.driver_profiles (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "userId" uuid NOT NULL,
    status public.driver_profiles_status_enum DEFAULT 'offline'::public.driver_profiles_status_enum NOT NULL,
    "ratingAvg" numeric(3,2) DEFAULT '5'::numeric NOT NULL,
    "totalTrips" integer DEFAULT 0 NOT NULL,
    "connectedAccountId" character varying,
    "idleSince" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.driver_subscriptions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "driverId" uuid NOT NULL,
    state public.driver_subscriptions_state_enum DEFAULT 'inactive'::public.driver_subscriptions_state_enum NOT NULL,
    "activatedAt" timestamp with time zone,
    "expiresAt" timestamp with time zone,
    "gracePeriodEndsAt" timestamp with time zone,
    "lastAmountPaid" numeric(10,2),
    "lastPaymentReference" character varying,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.driver_verifications (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "driverId" uuid NOT NULL,
    "licenseNumber" character varying NOT NULL,
    region character varying NOT NULL,
    "vehicleType" character varying NOT NULL,
    "vehicleYear" integer NOT NULL,
    status public.driver_verifications_status_enum DEFAULT 'pending'::public.driver_verifications_status_enum NOT NULL,
    "assignedToId" uuid,
    "missingId" boolean DEFAULT false NOT NULL,
    "missingInsurance" boolean DEFAULT false NOT NULL,
    "escalationReason" character varying,
    "escalatedToId" uuid,
    "rejectionReason" character varying,
    "submittedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.fares (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "rideId" uuid NOT NULL,
    "baseFare" numeric(10,2) NOT NULL,
    "distanceFare" numeric(10,2) NOT NULL,
    "timeFare" numeric(10,2) NOT NULL,
    "surgeMultiplier" numeric(5,2) DEFAULT '1'::numeric NOT NULL,
    "platformFee" numeric(10,2) DEFAULT '0'::numeric NOT NULL,
    total numeric(10,2) NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.gov_access_logs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "officerId" uuid NOT NULL,
    resource character varying NOT NULL,
    "resourceId" character varying,
    "ipAddress" character varying(64),
    "accessedAt" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.incidents (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "caseNumber" character varying NOT NULL,
    type public.incidents_type_enum NOT NULL,
    title character varying NOT NULL,
    description text NOT NULL,
    priority public.incidents_priority_enum DEFAULT 'medium'::public.incidents_priority_enum NOT NULL,
    status public.incidents_status_enum DEFAULT 'open'::public.incidents_status_enum NOT NULL,
    "reporterId" uuid NOT NULL,
    "reporterRole" character varying NOT NULL,
    "rideId" uuid,
    "relatedUserId" uuid,
    "relatedName" character varying,
    lat double precision,
    lng double precision,
    "locationLabel" character varying,
    "assignedToId" uuid,
    "assignedToName" character varying,
    "assignedAt" timestamp with time zone,
    "resolvedAt" timestamp with time zone,
    "reportedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.payment_events (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    provider public.payment_events_provider_enum NOT NULL,
    "providerReference" character varying NOT NULL,
    "driverId" uuid NOT NULL,
    amount numeric(10,2) NOT NULL,
    "rawPayload" jsonb NOT NULL,
    processed boolean DEFAULT false NOT NULL,
    "receivedAt" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.payments (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "userId" uuid NOT NULL,
    "rideId" uuid,
    type public.payments_type_enum NOT NULL,
    amount numeric(10,2) NOT NULL,
    "providerReference" character varying,
    "idempotencyKey" character varying NOT NULL,
    status public.payments_status_enum DEFAULT 'pending'::public.payments_status_enum NOT NULL,
    "connectedAccountId" character varying,
    "applicationFeeAmount" numeric(10,2) DEFAULT '0'::numeric NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ratings (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "rideId" uuid NOT NULL,
    "ratedBy" uuid NOT NULL,
    "ratedUser" uuid NOT NULL,
    stars integer NOT NULL,
    comment character varying,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.refresh_tokens (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "userId" uuid NOT NULL,
    "tokenHash" character varying NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "revokedAt" timestamp with time zone,
    "replacedById" uuid,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ride_messages (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "rideId" uuid NOT NULL,
    "senderId" uuid NOT NULL,
    body character varying(1000) NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ride_status_events (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "rideId" uuid NOT NULL,
    status public.ride_status_events_status_enum NOT NULL,
    "changedAt" timestamp with time zone DEFAULT now() NOT NULL,
    note character varying
);
CREATE TABLE public.rider_requests (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "riderId" uuid NOT NULL,
    pickup jsonb NOT NULL,
    dropoff jsonb NOT NULL,
    "earliestDeparture" timestamp with time zone NOT NULL,
    "latestDeparture" timestamp with time zone NOT NULL,
    "seatsNeeded" integer NOT NULL,
    "priceCeiling" numeric(10,2) NOT NULL,
    status public.rider_requests_status_enum DEFAULT 'queued'::public.rider_requests_status_enum NOT NULL,
    "queuedAt" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.rides (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "riderId" uuid NOT NULL,
    "driverId" uuid,
    status public.rides_status_enum DEFAULT 'requested'::public.rides_status_enum NOT NULL,
    pickup jsonb NOT NULL,
    dropoff jsonb NOT NULL,
    "pickupAddress" character varying,
    "dropoffAddress" character varying,
    "requestedAt" timestamp with time zone,
    "matchedAt" timestamp with time zone,
    "startedAt" timestamp with time zone,
    "completedAt" timestamp with time zone,
    "distanceM" integer,
    "durationS" integer,
    "vehicleType" character varying DEFAULT 'any'::character varying,
    "offerDriverId" uuid,
    "offerExpiresAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "quotedSurgeMultiplier" double precision
);
CREATE TABLE public.subscription_status_history (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "driverId" uuid NOT NULL,
    "fromState" public.subscription_status_history_fromstate_enum NOT NULL,
    "toState" public.subscription_status_history_tostate_enum NOT NULL,
    cause character varying NOT NULL,
    "paymentEventId" uuid,
    "occurredAt" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.tips (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "rideId" uuid NOT NULL,
    "riderId" uuid NOT NULL,
    "driverId" uuid NOT NULL,
    amount numeric(10,2) NOT NULL,
    "paymentId" uuid,
    status public.tips_status_enum DEFAULT 'pending'::public.tips_status_enum NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.trips (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "driverId" uuid NOT NULL,
    "startPoint" jsonb NOT NULL,
    destination jsonb NOT NULL,
    "routePath" jsonb NOT NULL,
    "departureTime" timestamp with time zone NOT NULL,
    "totalSeats" integer NOT NULL,
    "remainingSeats" integer NOT NULL,
    "pricePerSeat" numeric(10,2) NOT NULL,
    "inMatchingPool" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.user_accounts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "phoneNumber" character varying NOT NULL,
    "fullName" character varying,
    username character varying,
    "passwordHash" character varying,
    roles public.user_accounts_roles_enum[] DEFAULT '{rider}'::public.user_accounts_roles_enum[] NOT NULL,
    standing public.user_accounts_standing_enum DEFAULT 'good'::public.user_accounts_standing_enum NOT NULL,
    "savedPlaces" jsonb,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    tin character varying(32)
);
CREATE TABLE public.vehicles (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "driverId" uuid NOT NULL,
    make character varying NOT NULL,
    model character varying NOT NULL,
    plate character varying NOT NULL,
    capacity integer NOT NULL,
    color character varying,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE ONLY public.fares
    ADD CONSTRAINT "PK_01e9e567db5766e439be822b3d1" PRIMARY KEY (id);
ALTER TABLE ONLY public.rider_requests
    ADD CONSTRAINT "PK_09493aeae9fdf431ae92de1362f" PRIMARY KEY (id);
ALTER TABLE ONLY public.ratings
    ADD CONSTRAINT "PK_0f31425b073219379545ad68ed9" PRIMARY KEY (id);
ALTER TABLE ONLY public.user_accounts
    ADD CONSTRAINT "PK_125e915cf23ad1cfb43815ce59b" PRIMARY KEY (id);
ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT "PK_18d8646b59304dce4af3a9e35b6" PRIMARY KEY (id);
ALTER TABLE ONLY public.payments
    ADD CONSTRAINT "PK_197ab7af18c93fbb0c9b28b4a59" PRIMARY KEY (id);
ALTER TABLE ONLY public.driver_location_history
    ADD CONSTRAINT "PK_22cdcf969e7546a70deff6be5b7" PRIMARY KEY (id);
ALTER TABLE ONLY public.configuration
    ADD CONSTRAINT "PK_36aa5305bb4de9034d272f6a244" PRIMARY KEY (key);
ALTER TABLE ONLY public.driver_verifications
    ADD CONSTRAINT "PK_5da6e889c6abf4fd516c0835a00" PRIMARY KEY (id);
ALTER TABLE ONLY public.subscription_status_history
    ADD CONSTRAINT "PK_687f3f2e2f3df14b8029345fcab" PRIMARY KEY (id);
ALTER TABLE ONLY public.driver_profiles
    ADD CONSTRAINT "PK_6e002fc8a835351e070978fcad4" PRIMARY KEY (id);
ALTER TABLE ONLY public.driver_expenses
    ADD CONSTRAINT "PK_76ea327b399be00c0c053e6f8f5" PRIMARY KEY (id);
ALTER TABLE ONLY public.driver_subscriptions
    ADD CONSTRAINT "PK_7856cd39af1501d5f92faa5b18b" PRIMARY KEY (id);
ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT "PK_7d8bee0204106019488c4c50ffa" PRIMARY KEY (id);
ALTER TABLE ONLY public.document_submissions
    ADD CONSTRAINT "PK_85e12435fdeb3ea00860e4530d8" PRIMARY KEY (id);
ALTER TABLE ONLY public.driver_earnings
    ADD CONSTRAINT "PK_8e1fd49cf2a697c7e5bcc621461" PRIMARY KEY (id);
ALTER TABLE ONLY public.audit_trails
    ADD CONSTRAINT "PK_91440e9d8998d3faf5f8cd6b9ab" PRIMARY KEY (id);
ALTER TABLE ONLY public.payment_events
    ADD CONSTRAINT "PK_9f1d16fc78b33e676940a32e8b5" PRIMARY KEY (id);
ALTER TABLE ONLY public.tips
    ADD CONSTRAINT "PK_b63a628fdfd7517d8e58fe39199" PRIMARY KEY (id);
ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT "PK_bee6805982cc1e248e94ce94957" PRIMARY KEY (id);
ALTER TABLE ONLY public.rides
    ADD CONSTRAINT "PK_ca6f62fc1e999b139c7f28f07fd" PRIMARY KEY (id);
ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT "PK_ccb34c01719889017e2246469f9" PRIMARY KEY (id);
ALTER TABLE ONLY public.ride_status_events
    ADD CONSTRAINT "PK_d851fe4199b1e139c3af7341c84" PRIMARY KEY (id);
ALTER TABLE ONLY public.compliance_alerts
    ADD CONSTRAINT "PK_f1599228ad4c6dcc300efd16b9f" PRIMARY KEY (id);
ALTER TABLE ONLY public.trips
    ADD CONSTRAINT "PK_f71c231dee9c05a9522f9e840f5" PRIMARY KEY (id);
ALTER TABLE ONLY public.gov_access_logs
    ADD CONSTRAINT "PK_f8f1687daab3e30b2d5193592cd" PRIMARY KEY (id);
ALTER TABLE ONLY public.ride_messages
    ADD CONSTRAINT "PK_ride_messages" PRIMARY KEY (id);
ALTER TABLE ONLY public.driver_subscriptions
    ADD CONSTRAINT "REL_5e1358ad7e45ab2d12a4472c97" UNIQUE ("driverId");
CREATE UNIQUE INDEX "IDX_076052a44f3794396a4c8f7e1c" ON public.payment_events USING btree ("providerReference");
CREATE INDEX "IDX_1cd355d6801616bf1315f8c1ca" ON public.trips USING btree ("inMatchingPool");
CREATE UNIQUE INDEX "IDX_3d6a619788113f96912de862f4" ON public.user_accounts USING btree ("phoneNumber");
CREATE UNIQUE INDEX "IDX_447237514fa54db950dd84785b" ON public.fares USING btree ("rideId");
CREATE UNIQUE INDEX "IDX_743b9fb1d2a059f2f7860418e4" ON public.payments USING btree ("idempotencyKey");
CREATE UNIQUE INDEX "IDX_77ee9b1dbd98b06681eefb9af5" ON public.ratings USING btree ("rideId", "ratedBy");
CREATE INDEX "IDX_a4aeec3ca79ebfbe811508f39c" ON public.ride_status_events USING btree ("rideId");
CREATE INDEX "IDX_audit_trails_actor_occurred" ON public.audit_trails USING btree ("actorId", "occurredAt" DESC);
CREATE INDEX "IDX_audit_trails_target" ON public.audit_trails USING btree ("targetType", "targetId");
CREATE INDEX "IDX_bookings_riderRequestId" ON public.bookings USING btree ("riderRequestId");
CREATE INDEX "IDX_bookings_tripId" ON public.bookings USING btree ("tripId");
CREATE UNIQUE INDEX "IDX_c22d0ffc4bff60e9a39c003759" ON public.driver_profiles USING btree ("userId");
CREATE INDEX "IDX_compliance_alerts_driverId" ON public.compliance_alerts USING btree ("driverId");
CREATE UNIQUE INDEX "IDX_d45e7ca4a62293443961558c56" ON public.user_accounts USING btree (username);
CREATE INDEX "IDX_document_submissions_verification" ON public.document_submissions USING btree ("driverVerificationId");
CREATE INDEX "IDX_driver_earnings_driver_created" ON public.driver_earnings USING btree ("driverId", "createdAt" DESC);
CREATE INDEX "IDX_driver_earnings_source" ON public.driver_earnings USING btree ("sourceType", "sourceId");
CREATE INDEX "IDX_driver_expenses_driver_incurred" ON public.driver_expenses USING btree ("driverId", "incurredAt" DESC);
CREATE INDEX "IDX_driver_location_history_driver_recorded" ON public.driver_location_history USING btree ("driverId", "recordedAt" DESC);
CREATE INDEX "IDX_driver_location_history_recorded" ON public.driver_location_history USING btree ("recordedAt" DESC);
CREATE INDEX "IDX_driver_profiles_status" ON public.driver_profiles USING btree (status);
CREATE INDEX "IDX_driver_subscriptions_active_expires" ON public.driver_subscriptions USING btree (state, "expiresAt") WHERE ("expiresAt" IS NOT NULL);
CREATE INDEX "IDX_driver_subscriptions_past_due_grace" ON public.driver_subscriptions USING btree (state, "gracePeriodEndsAt") WHERE ("gracePeriodEndsAt" IS NOT NULL);
CREATE INDEX "IDX_driver_subscriptions_state_driver" ON public.driver_subscriptions USING btree (state, "driverId");
CREATE INDEX "IDX_driver_verifications_driverId" ON public.driver_verifications USING btree ("driverId");
CREATE INDEX "IDX_driver_verifications_status" ON public.driver_verifications USING btree (status);
CREATE INDEX "IDX_gov_access_logs_officer_accessed" ON public.gov_access_logs USING btree ("officerId", "accessedAt" DESC);
CREATE INDEX "IDX_incidents_assignedToId" ON public.incidents USING btree ("assignedToId") WHERE ("assignedToId" IS NOT NULL);
CREATE UNIQUE INDEX "IDX_incidents_caseNumber" ON public.incidents USING btree ("caseNumber");
CREATE INDEX "IDX_incidents_relatedUserId" ON public.incidents USING btree ("relatedUserId") WHERE ("relatedUserId" IS NOT NULL);
CREATE INDEX "IDX_incidents_reporterId" ON public.incidents USING btree ("reporterId");
CREATE INDEX "IDX_incidents_rideId" ON public.incidents USING btree ("rideId") WHERE ("rideId" IS NOT NULL);
CREATE INDEX "IDX_payment_events_driverId" ON public.payment_events USING btree ("driverId");
CREATE INDEX "IDX_payments_rideId" ON public.payments USING btree ("rideId") WHERE ("rideId" IS NOT NULL);
CREATE INDEX "IDX_payments_userId" ON public.payments USING btree ("userId");
CREATE INDEX "IDX_ratings_ratedUser" ON public.ratings USING btree ("ratedUser");
CREATE UNIQUE INDEX "IDX_refresh_tokens_tokenHash" ON public.refresh_tokens USING btree ("tokenHash");
CREATE INDEX "IDX_refresh_tokens_userId" ON public.refresh_tokens USING btree ("userId");
CREATE INDEX "IDX_refresh_tokens_user_active" ON public.refresh_tokens USING btree ("userId", "expiresAt") WHERE ("revokedAt" IS NULL);
CREATE INDEX "IDX_ride_messages_ride_created" ON public.ride_messages USING btree ("rideId", "createdAt");
CREATE INDEX "IDX_ride_status_events_ride_changed" ON public.ride_status_events USING btree ("rideId", "changedAt" DESC);
CREATE INDEX "IDX_rider_requests_riderId" ON public.rider_requests USING btree ("riderId");
CREATE INDEX "IDX_rides_driver_created" ON public.rides USING btree ("driverId", "createdAt" DESC) WHERE ("driverId" IS NOT NULL);
CREATE INDEX "IDX_rides_offer_driver" ON public.rides USING btree ("offerDriverId", status) WHERE ("offerDriverId" IS NOT NULL);
CREATE INDEX "IDX_rides_offer_expiry" ON public.rides USING btree ("offerExpiresAt") WHERE (status = 'offered'::public.rides_status_enum);
CREATE INDEX "IDX_rides_rider_created" ON public.rides USING btree ("riderId", "createdAt" DESC);
CREATE INDEX "IDX_rides_status_matchedAt" ON public.rides USING btree (status, "matchedAt") WHERE (status = 'matched'::public.rides_status_enum);
CREATE INDEX "IDX_rides_status_requested" ON public.rides USING btree (status, "requestedAt");
CREATE INDEX "IDX_rides_status_updated" ON public.rides USING btree (status, "updatedAt" DESC);
CREATE INDEX "IDX_subscription_status_history_driver" ON public.subscription_status_history USING btree ("driverId", "occurredAt" DESC);
CREATE INDEX "IDX_subscription_status_history_event" ON public.subscription_status_history USING btree ("paymentEventId") WHERE ("paymentEventId" IS NOT NULL);
CREATE INDEX "IDX_tips_driverId" ON public.tips USING btree ("driverId");
CREATE INDEX "IDX_tips_rideId" ON public.tips USING btree ("rideId");
CREATE INDEX "IDX_tips_riderId" ON public.tips USING btree ("riderId");
CREATE INDEX "IDX_trips_driverId" ON public.trips USING btree ("driverId");
CREATE INDEX "IDX_user_accounts_fullName_trgm" ON public.user_accounts USING gin ("fullName" public.gin_trgm_ops);
CREATE INDEX "IDX_vehicles_driverId" ON public.vehicles USING btree ("driverId");
CREATE UNIQUE INDEX "UQ_driver_subscriptions_driverId" ON public.driver_subscriptions USING btree ("driverId");
CREATE UNIQUE INDEX "UQ_rides_one_active_per_driver" ON public.rides USING btree ("driverId") WHERE (("driverId" IS NOT NULL) AND (status = ANY (ARRAY['matched'::public.rides_status_enum, 'accepted'::public.rides_status_enum, 'arriving'::public.rides_status_enum, 'in_progress'::public.rides_status_enum])));
CREATE UNIQUE INDEX "UQ_rides_one_active_per_rider" ON public.rides USING btree ("riderId") WHERE (status = ANY (ARRAY['requested'::public.rides_status_enum, 'searching'::public.rides_status_enum, 'offered'::public.rides_status_enum, 'matched'::public.rides_status_enum, 'accepted'::public.rides_status_enum, 'arriving'::public.rides_status_enum, 'in_progress'::public.rides_status_enum]));
CREATE UNIQUE INDEX "UQ_user_accounts_tin" ON public.user_accounts USING btree (tin) WHERE (tin IS NOT NULL);
CREATE UNIQUE INDEX "UQ_vehicles_driverId" ON public.vehicles USING btree ("driverId");
ALTER TABLE ONLY public.driver_subscriptions
    ADD CONSTRAINT "FK_5e1358ad7e45ab2d12a4472c975" FOREIGN KEY ("driverId") REFERENCES public.user_accounts(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.audit_trails
    ADD CONSTRAINT "FK_audit_trails_actorId" FOREIGN KEY ("actorId") REFERENCES public.user_accounts(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT "FK_bookings_riderRequestId" FOREIGN KEY ("riderRequestId") REFERENCES public.rider_requests(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT "FK_bookings_tripId" FOREIGN KEY ("tripId") REFERENCES public.trips(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.compliance_alerts
    ADD CONSTRAINT "FK_compliance_alerts_driverId" FOREIGN KEY ("driverId") REFERENCES public.user_accounts(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.document_submissions
    ADD CONSTRAINT "FK_document_submissions_driverVerificationId" FOREIGN KEY ("driverVerificationId") REFERENCES public.driver_verifications(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.driver_earnings
    ADD CONSTRAINT "FK_driver_earnings_driverId" FOREIGN KEY ("driverId") REFERENCES public.user_accounts(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.driver_expenses
    ADD CONSTRAINT "FK_driver_expenses_driverId" FOREIGN KEY ("driverId") REFERENCES public.user_accounts(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.driver_location_history
    ADD CONSTRAINT "FK_driver_location_history_driverId" FOREIGN KEY ("driverId") REFERENCES public.user_accounts(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.driver_profiles
    ADD CONSTRAINT "FK_driver_profiles_userId" FOREIGN KEY ("userId") REFERENCES public.user_accounts(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.driver_verifications
    ADD CONSTRAINT "FK_driver_verifications_assignedToId" FOREIGN KEY ("assignedToId") REFERENCES public.user_accounts(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.driver_verifications
    ADD CONSTRAINT "FK_driver_verifications_driverId" FOREIGN KEY ("driverId") REFERENCES public.user_accounts(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.driver_verifications
    ADD CONSTRAINT "FK_driver_verifications_escalatedToId" FOREIGN KEY ("escalatedToId") REFERENCES public.user_accounts(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.fares
    ADD CONSTRAINT "FK_fares_rideId" FOREIGN KEY ("rideId") REFERENCES public.rides(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.gov_access_logs
    ADD CONSTRAINT "FK_gov_access_logs_officerId" FOREIGN KEY ("officerId") REFERENCES public.user_accounts(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT "FK_incidents_assignedToId" FOREIGN KEY ("assignedToId") REFERENCES public.user_accounts(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT "FK_incidents_relatedUserId" FOREIGN KEY ("relatedUserId") REFERENCES public.user_accounts(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT "FK_incidents_reporterId" FOREIGN KEY ("reporterId") REFERENCES public.user_accounts(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT "FK_incidents_rideId" FOREIGN KEY ("rideId") REFERENCES public.rides(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.payment_events
    ADD CONSTRAINT "FK_payment_events_driverId" FOREIGN KEY ("driverId") REFERENCES public.user_accounts(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.payments
    ADD CONSTRAINT "FK_payments_rideId" FOREIGN KEY ("rideId") REFERENCES public.rides(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.payments
    ADD CONSTRAINT "FK_payments_userId" FOREIGN KEY ("userId") REFERENCES public.user_accounts(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.ratings
    ADD CONSTRAINT "FK_ratings_ratedBy" FOREIGN KEY ("ratedBy") REFERENCES public.user_accounts(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.ratings
    ADD CONSTRAINT "FK_ratings_ratedUser" FOREIGN KEY ("ratedUser") REFERENCES public.user_accounts(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.ratings
    ADD CONSTRAINT "FK_ratings_rideId" FOREIGN KEY ("rideId") REFERENCES public.rides(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT "FK_refresh_tokens_replacedById" FOREIGN KEY ("replacedById") REFERENCES public.refresh_tokens(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT "FK_refresh_tokens_userId" FOREIGN KEY ("userId") REFERENCES public.user_accounts(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.ride_messages
    ADD CONSTRAINT "FK_ride_messages_rideId" FOREIGN KEY ("rideId") REFERENCES public.rides(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.ride_messages
    ADD CONSTRAINT "FK_ride_messages_senderId" FOREIGN KEY ("senderId") REFERENCES public.user_accounts(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.ride_status_events
    ADD CONSTRAINT "FK_ride_status_events_rideId" FOREIGN KEY ("rideId") REFERENCES public.rides(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.rider_requests
    ADD CONSTRAINT "FK_rider_requests_riderId" FOREIGN KEY ("riderId") REFERENCES public.user_accounts(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.rides
    ADD CONSTRAINT "FK_rides_driverId" FOREIGN KEY ("driverId") REFERENCES public.user_accounts(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.rides
    ADD CONSTRAINT "FK_rides_offerDriverId" FOREIGN KEY ("offerDriverId") REFERENCES public.user_accounts(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.rides
    ADD CONSTRAINT "FK_rides_riderId" FOREIGN KEY ("riderId") REFERENCES public.user_accounts(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.subscription_status_history
    ADD CONSTRAINT "FK_subscription_status_history_driverId" FOREIGN KEY ("driverId") REFERENCES public.user_accounts(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.subscription_status_history
    ADD CONSTRAINT "FK_subscription_status_history_paymentEventId" FOREIGN KEY ("paymentEventId") REFERENCES public.payment_events(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.tips
    ADD CONSTRAINT "FK_tips_driverId" FOREIGN KEY ("driverId") REFERENCES public.user_accounts(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.tips
    ADD CONSTRAINT "FK_tips_paymentId" FOREIGN KEY ("paymentId") REFERENCES public.payments(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.tips
    ADD CONSTRAINT "FK_tips_rideId" FOREIGN KEY ("rideId") REFERENCES public.rides(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.tips
    ADD CONSTRAINT "FK_tips_riderId" FOREIGN KEY ("riderId") REFERENCES public.user_accounts(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.trips
    ADD CONSTRAINT "FK_trips_driverId" FOREIGN KEY ("driverId") REFERENCES public.user_accounts(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT "FK_vehicles_driverId" FOREIGN KEY ("driverId") REFERENCES public.user_accounts(id) ON DELETE CASCADE;
`;
