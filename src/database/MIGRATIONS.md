# TypeORM migrations (api-core)

Schema changes ship as TypeORM migrations. **`synchronize` is off in production.**

## Commands

```bash
cd api-core

# Show pending / applied
npm run migration:show

# Apply pending
npm run migration:run

# Revert last
npm run migration:revert

# After entity changes, generate a diff migration against the live DB
npm run typeorm -- migration:generate src/database/migrations/DescribeChange -p
```

Nest boots with `TYPEORM_MIGRATIONS_RUN=true` (default) and applies pending migrations automatically.

## Local emergency sync

Empty local DB and you need a quick bootstrap (never in production):

```bash
TYPEORM_SYNCHRONIZE=true npm run start:dev
# then turn it back off and use migrations going forward
```

## Fresh production / Neon

1. Ensure `NODE_ENV=production` (forces synchronize off)
2. Set `DATABASE_DIRECT_URL` to the non-pooler Neon URL for DDL
3. Prefer `npm run migration:run` in CI (uses direct URL), or `TYPEORM_MIGRATIONS_RUN=true` on boot
4. App runtime keeps `DATABASE_URL` on the **pooler** — see [POOLING.md](./POOLING.md)

Existing environments that were created with synchronize only need new migrations from this folder (e.g. `AddIncidents`).
