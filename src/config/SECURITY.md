# Strict CORS + Helmet (api-core)

Browser portals (Ops / Gov) must be on an explicit Origin allowlist.
Native Flutter clients do not send `Origin` and are unaffected.

## Env

```bash
# Comma-separated, no trailing slashes required
CORS_ORIGINS=https://ops.example.com,https://gov.example.com
```

| Environment | Behavior |
|-------------|----------|
| **development** (unset) | Defaults to localhost `5173` / `5174` / `3000` |
| **production** (unset) | Empty allowlist — browser Origins denied |
| **any** (set) | Only listed Origins reflected |

Credentials enabled; methods + auth / webhook headers allowlisted.
Rate-limit headers are exposed to browsers.

## Helmet

Applied in `main.ts`:

- Default Helmet protections (XSS filter legacy off in modern helmet, `X-Content-Type-Options`, frameguard, etc.)
- `contentSecurityPolicy: false` (JSON API)
- `crossOriginResourcePolicy: cross-origin` (KYC images from portals)
- HSTS on when `NODE_ENV=production`

## Socket.IO

`NotificationsGateway` uses the same allowlist (`buildSocketCors()`), not `cors: true`.

## Code

- `src/config/security.config.ts`
- `src/main.ts`
