# Auth tokens (JWT access + rotating refresh)

## Model

| Token | Format | Lifetime | Storage |
|-------|--------|----------|---------|
| **Access** | JWT (`typ=access`, `jti`) | `JWT_ACCESS_EXPIRES_IN` (e.g. 15m) | Client only; denylist in Redis on `logout-all` |
| **Refresh** | Opaque (`base64url`) | `JWT_REFRESH_EXPIRES_IN` (e.g. 30d) | SHA-256 in `refresh_tokens` table |

## Rotation

`POST /auth/refresh` `{ "refreshToken": "..." }`:

1. Lookup hash; reject if missing/expired  
2. If **already revoked** → treat as reuse → **revoke all** sessions for that user  
3. Otherwise revoke current row, issue new access + refresh pair  

## Revocation

| Endpoint | Effect |
|----------|--------|
| `POST /auth/logout` | Revoke that refresh token |
| `POST /auth/logout-all` | Bearer access required; revoke all refresh rows + Redis denylist `jti` |

Access tokens without denylist entry remain valid until expiry (short TTL).

## Client notes

- Do **not** send the access JWT to `/auth/refresh` (old behavior removed)  
- Persist the latest `refreshToken` after every refresh  
- On reuse detection (`401` with reuse message), force re-login  
