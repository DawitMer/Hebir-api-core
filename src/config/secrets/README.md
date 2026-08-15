# Secrets management (api-core)

**Local:** `.env` via Nest `ConfigModule` (`SECRETS_BACKEND=env`, default).  
**Production:** load secrets from **AWS Secrets Manager** (or a mounted JSON file).  
Do not ship long-lived production secrets only in a `.env` on disk.

See also: [`docs/SECRETS.md`](../../../docs/SECRETS.md).

## Boot

`main.ts` calls `loadSecretsIntoEnv()` **before** Nest starts.  
In `NODE_ENV=production`, `ConfigModule` sets `ignoreEnvFile: true` so a stray `.env` is not read.

## Backends

| `SECRETS_BACKEND` | Behavior |
|-------------------|----------|
| `env` (default non-prod) | Use process env / `.env` only |
| `aws` (default in production) | `GetSecretValue` JSON → `process.env` |
| `file` | Read `SECRETS_FILE` (JSON object) |

Production with `SECRETS_BACKEND=env` **fails** unless `ALLOW_ENV_SECRETS_IN_PROD=true`.

## AWS setup

1. Create a secret (JSON) matching [`secrets.example.json`](../../../secrets.example.json)  
2. Grant the task role `secretsmanager:GetSecretValue` on that ARN  
3. Set:

```bash
NODE_ENV=production
SECRETS_BACKEND=aws
SECRETS_ARN=arn:aws:secretsmanager:REGION:ACCOUNT:secret:hebir/api-core/prod
AWS_REGION=eu-central-1
# Non-secret config may stay in the task definition:
PORT=3000
LOCATION_SVC_URL=http://location-svc:8090
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=30d
```

Existing process env wins over secret keys unless `SECRETS_OVERWRITE=true`.

## CLI (migrations)

```bash
SECRETS_BACKEND=aws SECRETS_ARN=... \
  npx ts-node -r tsconfig-paths/register scripts/with-secrets.ts -- npm run migration:run
```

Or: `npm run secrets:migration:run` (same wrapper).
