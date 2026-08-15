# api-core

NestJS core API for Hebir. Owns auth, subscriptions, matching, booking, KYC,
and government reporting. Real-time geo work is delegated to sibling
[`location-svc`](../location-svc).

## Local setup

```bash
cp -n .env.example .env
docker compose up -d          # Postgres + Redis (port 16380)
npm install
npm run start:dev             # :3000
```

In another terminal:

```bash
cd ../location-svc
GOTOOLCHAIN=local REDIS_ADDR=localhost:16380 PORT=8090 go run .
```

Key env vars (see `.env.example`):

- `LOCATION_SVC_URL=http://localhost:8090`
- `REDIS_PORT=16380`
- JWT + DB credentials

## Client entry points

| Client | Routes |
|---|---|
| Driver / Rider apps | `/auth/*`, `/trips`, `/rider-requests`, `/bookings`, `/subscription/*`, `/drivers/location`, `/demand/grid`, `/fare/*` |
| Operations portal | `/kyc/*` |
| Government portal | `/gov/*` |

Driver GPS: `POST /drivers/location` → proxied to location-svc.  
Demand heat: `GET /demand/grid` → location-svc Redis cells.

Matching layout: [`src/modules/matching/README.md`](src/modules/matching/README.md).  
Team docs: [`../docs/MODULE_MAP.md`](../docs/MODULE_MAP.md), [`../docs/MATCHING.md`](../docs/MATCHING.md).  
Backups / PITR: [`../docs/BACKUP_PITR.md`](../docs/BACKUP_PITR.md); optional dump workflow under [`.github/workflows/`](.github/workflows/).  
Secrets (prod): [`../docs/SECRETS.md`](../docs/SECRETS.md); template [`secrets.example.json`](secrets.example.json).

See [`../docs/STACK.md`](../docs/STACK.md) for the full local stack.
