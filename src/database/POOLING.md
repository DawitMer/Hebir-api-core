# Postgres pooling (PgBouncer / Neon pooler)

api-core must not open unbounded Postgres connections. At scale, every Nest
replica opens a client pool; without a pooler those sockets exhaust Neon /
Postgres `max_connections`.

## Production (Neon)

1. **App runtime** — use Neon’s **pooled** connection string (`…-pooler.…`):

   ```bash
   DATABASE_URL=postgresql://…@ep-xxxx-pooler.…/neondb?sslmode=require
   ```

2. **Migrations / DDL** — use Neon’s **direct** (non-pooler) string:

   ```bash
   DATABASE_DIRECT_URL=postgresql://…@ep-xxxx.…/neondb?sslmode=require
   npm run migration:run
   ```

   CLI `data-source.ts` prefers `DATABASE_DIRECT_URL`.

3. **Client pool caps** (defaults apply when unset):

   | Var | Behind pooler | Direct Postgres |
   |-----|---------------|-----------------|
   | `DB_POOL_MAX` | **10** | **20** |
   | `DB_POOL_MIN` | 0 | 0 |
   | `DB_POOL_IDLE_TIMEOUT_MS` | 30000 | 30000 |
   | `DB_POOL_CONNECTION_TIMEOUT_MS` | 10000 | 10000 |

   Rule of thumb: `replicas × DB_POOL_MAX` ≪ Neon compute connection limit.
   Prefer raising PgBouncer / Neon pool size over raising `DB_POOL_MAX`.

4. Optional: `DB_USE_PGBOUNCER=true` forces “behind pooler” defaults even if the
   URL hostname does not contain `-pooler`.

## Local (docker-compose)

```bash
cd api-core && docker compose up -d postgres pgbouncer redis
```

| Role | URL |
|------|-----|
| App (pooled) | `postgresql://hebir:hebir@127.0.0.1:6432/hebir` |
| Migrations (direct) | `postgresql://hebir:hebir@127.0.0.1:5432/hebir` |

```bash
# .env sketch
DATABASE_URL=postgresql://hebir:hebir@127.0.0.1:6432/hebir
DATABASE_DIRECT_URL=postgresql://hebir:hebir@127.0.0.1:5432/hebir
DB_USE_PGBOUNCER=true
DB_POOL_MAX=10
TYPEORM_SYNCHRONIZE=false
TYPEORM_MIGRATIONS_RUN=false   # run CLI against DIRECT_URL instead
```

PgBouncer runs in **transaction** mode (`POOL_MODE=transaction`,
`MAX_CLIENT_CONN=400`, `DEFAULT_POOL_SIZE=20`). Image: `edoburu/pgbouncer:v1.19.1-p0`.

## What TypeORM sets

`database.module.ts` / `pool.config.ts` pass:

- `poolSize` / `extra.max` — client pool ceiling
- `connectTimeoutMS` / `extra.connectionTimeoutMillis`
- `extra.idleTimeoutMillis`, `allowExitOnIdle`
- `applicationName` (`api-core` / `api-core-migrate`)

`synchronize` stays off in production; schema changes stay on migrations.
