# Rate limiting

Redis token buckets on auth, payment webhooks, and GPS / demand paths.
Multi-instance safe via shared Redis (`INCR` + `EXPIRE`).

## Protected routes (api-core)

| Route | Default | Key |
|-------|---------|-----|
| `POST /auth/register`, `/auth/login` | 10 / 60s | client IP |
| `POST /auth/refresh` | 30 / 60s | user id |
| `POST /subscription/webhook` | 120 / 60s | client IP |
| `POST /drivers/location` | 20 / 60s | user id |
| `GET /demand/grid` | 30 / 60s | user id |

Returns **429** with `Retry-After` and `X-RateLimit-*` headers.

## Env

```bash
RATE_LIMIT_ENABLED=true          # set false to disable (local seeds)
RATE_LIMIT_AUTH=10               # optional overrides (per-minute window)
RATE_LIMIT_AUTH_REFRESH=30
RATE_LIMIT_WEBHOOK=120
RATE_LIMIT_GPS=20
RATE_LIMIT_DEMAND=30
```

## location-svc

`POST /drivers/location` is also limited per `driverId` (same 20/min default,
`RATE_LIMIT_GPS` / `RATE_LIMIT_ENABLED`) so direct hits bypassing api-core
cannot flood Redis GEO.
