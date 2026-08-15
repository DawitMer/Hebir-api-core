/**
 * Wipe public app data (keep schema + migrations) and seed a demo fleet:
 *   - 20 live drivers (online + Redis GPS around Addis)
 *   - 100 riders
 *   - Ops admin + Gov officer
 *
 *   cd api-core && npm run seed:demo
 *
 * Requires location-svc + Redis for GPS pings (api-core optional for verify).
 */
import axios from 'axios';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Redis from 'ioredis';
import { Client } from 'pg';
import { CONFIG_DEFAULTS } from '../src/modules/subscription/entities/configuration.entity';

const API = process.env.API_BASE_URL ?? 'http://127.0.0.1:3000';
const LOC = process.env.LOCATION_SVC_URL ?? 'http://127.0.0.1:8090';
const PASSWORD = 'secret123';
const DRIVER_COUNT = Number(process.env.SEED_DRIVERS ?? 20);
const RIDER_COUNT = Number(process.env.SEED_RIDERS ?? 100);
const ADDIS = { lat: 8.9806, lng: 38.7578 };

const FIRST = [
  'Abebe', 'Sara', 'Yonas', 'Marta', 'Hanna', 'Daniel', 'Kaleb', 'Liya',
  'Biruk', 'Selam', 'Dawit', 'Helen', 'Mulugeta', 'Tigist', 'Elias', 'Rahel',
  'Getachew', 'Meron', 'Samuel', 'Bethlehem', 'Nahom', 'Kidist', 'Fikadu', 'Sosina',
];
const LAST = [
  'Bekele', 'Hailu', 'Desta', 'Alemu', 'Tadesse', 'Mekonnen', 'Tesfaye', 'Assefa',
  'Gebre', 'Wolde', 'Kebede', 'Negash', 'Abebe', 'Lemma', 'Girma', 'Yilma',
];
const VEHICLES = [
  { make: 'Toyota', model: 'Corolla', color: 'White' },
  { make: 'Hyundai', model: 'Accent', color: 'Silver' },
  { make: 'Suzuki', model: 'Dzire', color: 'Blue' },
  { make: 'Toyota', model: 'Yaris', color: 'Black' },
  { make: 'Honda', model: 'Civic', color: 'Grey' },
  { make: 'Kia', model: 'Rio', color: 'Red' },
];

function loadEnvFile() {
  const envPath = path.resolve(__dirname, '../.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function nameAt(i: number) {
  return `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`;
}

function username(fullName: string, i: number, role: string) {
  const base = fullName
    .toLowerCase()
    .replace(/[^a-z]+/g, '_')
    .replace(/^_|_$/g, '');
  return `${base}_${role}${String(i).padStart(3, '0')}`;
}

function offset(i: number, total: number) {
  const angle = (2 * Math.PI * i) / total;
  const ring = 0.006 + (i % 5) * 0.006;
  return {
    lat: ADDIS.lat + Math.cos(angle) * ring,
    lng: ADDIS.lng + Math.sin(angle) * ring * 1.1,
  };
}

async function wipePostgres(client: Client) {
  const { rows } = await client.query(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> 'migrations'
    ORDER BY tablename
  `);
  const tables = rows.map((r: { tablename: string }) => `"${r.tablename}"`);
  if (!tables.length) return;
  console.log(`  truncating ${tables.length} tables…`);
  await client.query(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
}

async function flushRedis() {
  const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:16380';
  const redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    lazyConnect: true,
  });
  try {
    await redis.connect();
    await redis.flushdb();
    console.log('  redis FLUSHDB ok');
  } catch (err: any) {
    console.warn(`  redis flush skipped: ${err?.message ?? err}`);
  } finally {
    redis.disconnect();
  }
}

type SeedUser = {
  id: string;
  phone: string;
  fullName: string;
  username: string;
  roles: string[];
  tin?: string | null;
};

async function main() {
  loadEnvFile();
  if (!process.env.REDIS_URL || /upstash/i.test(process.env.REDIS_URL)) {
    process.env.REDIS_URL = 'redis://127.0.0.1:16380';
  }

  const databaseUrl = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  console.log('==> Wipe Postgres app data');
  const client = new Client({
    connectionString: databaseUrl,
    ssl: /sslmode=require/i.test(databaseUrl)
      ? { rejectUnauthorized: false }
      : undefined,
  });
  await client.connect();
  await wipePostgres(client);

  console.log('==> Flush Redis geo / demand');
  await flushRedis();

  console.log(
    `==> Seed ${DRIVER_COUNT} live drivers + ${RIDER_COUNT} riders (+ ops/gov)`,
  );
  /** Only ops/gov keep a password. Rider/driver are phone+OTP (null hash). */
  const staffPasswordHash = await bcrypt.hash(PASSWORD, 10);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const gracePeriodEndsAt = new Date(expiresAt.getTime() + 24 * 60 * 60 * 1000);

  const users: SeedUser[] = [
    {
      id: randomUUID(),
      phone: '+251911000001',
      fullName: 'Ops Admin',
      username: 'ops_admin',
      roles: ['admin'],
    },
    {
      id: randomUUID(),
      phone: '+251911000002',
      fullName: 'Gov Officer',
      username: 'gov_officer',
      roles: ['gov_officer'],
    },
  ];

  const drivers: Array<SeedUser & { loc: { lat: number; lng: number } }> = [];
  for (let i = 1; i <= DRIVER_COUNT; i++) {
    const fullName = nameAt(i - 1);
    const phone = `+2519112${String(i).padStart(5, '0')}`;
    const row = {
      id: randomUUID(),
      phone,
      fullName,
      username: username(fullName, i, 'd'),
      roles: ['driver'],
      // Deterministic 10-digit TIN from phone suffix (demo + searchable).
      tin: `00${phone.replace(/\D/g, '').slice(-8)}`,
      loc: offset(i - 1, DRIVER_COUNT),
    };
    users.push(row);
    drivers.push(row);
  }

  for (let i = 1; i <= RIDER_COUNT; i++) {
    const fullName = nameAt(i + 40);
    users.push({
      id: randomUUID(),
      phone: `+2519223${String(i).padStart(5, '0')}`,
      fullName,
      username: username(fullName, i, 'r'),
      roles: ['rider'],
    });
  }

  await client.query('BEGIN');
  try {
    {
      const ph: string[] = [];
      const vals: unknown[] = [];
      users.forEach((u, idx) => {
        const o = idx * 8;
        ph.push(
          `($${o + 1}::uuid,$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7}::text[]::user_accounts_roles_enum[],$${o + 8}::user_accounts_standing_enum)`,
        );
        const isStaff =
          u.roles.includes('admin') || u.roles.includes('gov_officer');
        vals.push(
          u.id,
          u.phone,
          u.fullName,
          u.username,
          u.tin ?? null,
          isStaff ? staffPasswordHash : null,
          u.roles,
          'good',
        );
      });
      await client.query(
        `INSERT INTO user_accounts (id, "phoneNumber", "fullName", username, tin, "passwordHash", roles, standing)
         VALUES ${ph.join(',')}`,
        vals,
      );
    }

    {
      const ph: string[] = [];
      const vals: unknown[] = [];
      drivers.forEach((d, idx) => {
        const o = idx * 5;
        ph.push(
          `($${o + 1}::uuid,$${o + 2},$${o + 3}::driver_profiles_status_enum,$${o + 4},$${o + 5}::timestamptz)`,
        );
        vals.push(
          randomUUID(),
          d.id,
          'online',
          `acct_${d.phone.replace(/\D/g, '')}`,
          now.toISOString(),
        );
      });
      await client.query(
        `INSERT INTO driver_profiles (id, "userId", status, "connectedAccountId", "idleSince")
         VALUES ${ph.join(',')}`,
        vals,
      );
    }

    {
      const ph: string[] = [];
      const vals: unknown[] = [];
      drivers.forEach((d, idx) => {
        const v = VEHICLES[idx % VEHICLES.length];
        const o = idx * 7;
        ph.push(
          `($${o + 1}::uuid,$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7})`,
        );
        vals.push(
          randomUUID(),
          d.id,
          v.make,
          v.model,
          `AA-T ${String(10000 + idx).padStart(5, '0')}`,
          4,
          v.color,
        );
      });
      await client.query(
        `INSERT INTO vehicles (id, "driverId", make, model, plate, capacity, color)
         VALUES ${ph.join(',')}`,
        vals,
      );
    }

    {
      const ph: string[] = [];
      const vals: unknown[] = [];
      drivers.forEach((d, idx) => {
        const o = idx * 8;
        ph.push(
          `($${o + 1}::uuid,$${o + 2}::uuid,$${o + 3}::driver_subscriptions_state_enum,$${o + 4}::timestamptz,$${o + 5}::timestamptz,$${o + 6}::timestamptz,$${o + 7},$${o + 8})`,
        );
        vals.push(
          randomUUID(),
          d.id,
          'active',
          now.toISOString(),
          expiresAt.toISOString(),
          gracePeriodEndsAt.toISOString(),
          '1000.00',
          `seed-${d.id.slice(0, 8)}`,
        );
      });
      await client.query(
        `INSERT INTO driver_subscriptions
           (id, "driverId", state, "activatedAt", "expiresAt", "gracePeriodEndsAt", "lastAmountPaid", "lastPaymentReference")
         VALUES ${ph.join(',')}`,
        vals,
      );
    }

    for (let i = 0; i < Math.min(8, drivers.length); i++) {
      const d = drivers[i];
      const v = VEHICLES[i % VEHICLES.length];
      await client.query(
        `INSERT INTO driver_verifications
           (id, "driverId", "licenseNumber", region, "vehicleType", "vehicleYear", status)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::driver_verifications_status_enum)`,
        [
          randomUUID(),
          d.id,
          `ET-${d.phone.replace(/\D/g, '').slice(-6)}`,
          'Addis Ababa',
          v.make,
          2018 + (i % 6),
          i % 3 === 0 ? 'in_review' : 'pending',
        ],
      );
      await client.query(
        `INSERT INTO driver_expenses (id, "driverId", category, amount, description, "incurredAt")
         VALUES
           ($1::uuid,$2,'Fuel','850.00','Weekly fuel',$3::timestamptz),
           ($4::uuid,$2,'Maintenance','1200.00','Oil change',$5::timestamptz)`,
        [
          randomUUID(),
          d.id,
          new Date(Date.now() - 3 * 86400000).toISOString(),
          randomUUID(),
          new Date(Date.now() - 10 * 86400000).toISOString(),
        ],
      );
    }

    {
      const entries = Object.entries(CONFIG_DEFAULTS);
      const ph: string[] = [];
      const vals: unknown[] = [];
      entries.forEach(([key, value], idx) => {
        const o = idx * 3;
        ph.push(`($${o + 1},$${o + 2}::jsonb,$${o + 3})`);
        vals.push(key, JSON.stringify(value), `seed default for ${key}`);
      });
      await client.query(
        `INSERT INTO configuration (key, value, description) VALUES ${ph.join(',')}`,
        vals,
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }

  console.log('==> Push live GPS to location-svc');
  let locOk = 0;
  for (const d of drivers) {
    try {
      await axios.post(`${LOC}/drivers/location`, {
        driverId: d.id,
        location: d.loc,
      });
      locOk += 1;
    } catch (err: any) {
      console.warn(`  loc skip ${d.phone}:`, err?.message ?? err);
    }
  }
  console.log(`  location-svc ok: ${locOk}/${drivers.length}`);

  try {
    const nearby = await axios.post(`${LOC}/drivers/nearby`, {
      pickup: ADDIS,
      radiusKm: 12,
    });
    console.log('  redis nearby drivers:', nearby.data?.driverIds?.length ?? nearby.data);
    const listed = await axios.get(`${LOC}/drivers/locations`, {
      params: { lat: ADDIS.lat, lng: ADDIS.lng, radiusKm: 12 },
    });
    console.log('  redis map pins:', listed.data?.drivers?.length ?? listed.data);
  } catch (err: any) {
    console.warn('  nearby check failed:', err?.message ?? err);
  }

  const counts = await client.query(`
    SELECT
      (SELECT count(*)::int FROM user_accounts WHERE 'driver' = ANY(roles)) AS drivers,
      (SELECT count(*)::int FROM user_accounts WHERE 'rider' = ANY(roles)) AS riders,
      (SELECT count(*)::int FROM driver_profiles WHERE status::text = 'online') AS online,
      (SELECT count(*)::int FROM driver_subscriptions WHERE state::text = 'active') AS active_subs,
      (SELECT count(*)::int FROM driver_verifications) AS kyc_queue,
      (SELECT count(*)::int FROM driver_expenses) AS expenses
  `);
  console.log('  db counts:', counts.rows[0]);
  await client.end();

  try {
    const h = await axios.get(`${API}/healthz`);
    console.log('  api health:', h.status);
  } catch {
    console.warn('  api health: down (DB seed is done; restart api-core if needed)');
  }

  console.log(`
Seed complete.

  Ops portal:  +251911000001 / ${PASSWORD} (+ portal OTP)
  Gov portal:  +251911000002 / ${PASSWORD} (+ portal OTP)
  Drivers:     +251911200001 … +2519112${String(DRIVER_COUNT).padStart(5, '0')}  (phone OTP; TIN 0011200001 …)
  Riders:      +251922300001 … +2519223${String(RIDER_COUNT).padStart(5, '0')}  (phone OTP only)
  Try:         driver +251911200001 / rider +251922300001 — OTP debugCode from POST /auth/otp/request
  Gov search:  name "Abebe" or TIN 0011200001
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
