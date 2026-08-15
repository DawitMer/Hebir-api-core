-- Reference DDL for on-demand rides additions (TypeORM synchronize creates these
-- in non-production). Keep in sync with api-core entities under modules/rides,
-- tips, ratings, location.

-- Partial-style availability helper (app filters status=online + subscription).
CREATE INDEX IF NOT EXISTS idx_driver_profiles_online
  ON driver_profiles (status)
  WHERE status = 'online';

CREATE INDEX IF NOT EXISTS idx_rides_status ON rides (status);
CREATE INDEX IF NOT EXISTS idx_rides_rider ON rides (rider_id);
CREATE INDEX IF NOT EXISTS idx_rides_driver ON rides (driver_id);

CREATE INDEX IF NOT EXISTS idx_driver_location_history_driver_time
  ON driver_location_history (driver_id, recorded_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_idempotency
  ON payments (idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ratings_ride_rater
  ON ratings (ride_id, rated_by);
