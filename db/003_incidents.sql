-- Ops incidents / SOS (also created via TypeORM synchronize in non-prod)
CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "caseNumber" varchar NOT NULL UNIQUE,
  type varchar NOT NULL,
  title varchar NOT NULL,
  description text NOT NULL,
  priority varchar NOT NULL DEFAULT 'medium',
  status varchar NOT NULL DEFAULT 'open',
  "reporterId" uuid NOT NULL,
  "reporterRole" varchar NOT NULL,
  "rideId" uuid NULL,
  "relatedUserId" uuid NULL,
  "relatedName" varchar NULL,
  lat double precision NULL,
  lng double precision NULL,
  "locationLabel" varchar NULL,
  "assignedToId" uuid NULL,
  "assignedToName" varchar NULL,
  "assignedAt" timestamptz NULL,
  "resolvedAt" timestamptz NULL,
  "reportedAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents (status);
CREATE INDEX IF NOT EXISTS idx_incidents_type ON incidents (type);
CREATE INDEX IF NOT EXISTS idx_incidents_reported ON incidents ("reportedAt" DESC);
