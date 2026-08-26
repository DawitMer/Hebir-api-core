# Nightly Neon pg_dump → S3 (optional cold backup)

Disabled until secrets are configured. Complements Neon Instant restore
(see `docs/BACKUP_PITR.md`). Uses the **direct** (non-pooler) connection string.

## Required GitHub secrets (api-core repo)

| Secret | Purpose |
|--------|---------|
| `DATABASE_DIRECT_URL` | Neon direct URI (`sslmode=require`) |
| `BACKUP_S3_BUCKET` | Destination bucket |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Upload credentials |
| `AWS_REGION` | e.g. `eu-central-1` |

## Enable

1. Add secrets above  
2. Uncomment the `schedule:` cron in this file (or run **Actions → Run workflow**)  
3. Confirm an object appears under `s3://$BUCKET/neon/…` after a run  

Retention: configure an S3 lifecycle rule to expire dumps after **30 days**.
