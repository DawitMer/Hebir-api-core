# Matching module

Orchestrates advanced ride-share **search + rank**.

| File / folder | Role |
|---|---|
| `matching.service.ts` | Pipeline orchestration (DB + location-svc + fare) |
| `geo/geo.util.ts` | Haversine, bearings, zone IDs |
| `scoring/match-score.ts` | Pure ranking formula |
| `entities/` | Trip, RiderRequest |
| `dto/` | Publish / submit payloads |

Team docs: [`docs/MATCHING.md`](../../../../docs/MATCHING.md).
