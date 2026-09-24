# Ride dispatch queue

On-demand matching uses a **Redis delayed job** queue with **H3 hexagonal
geographic expansion** (not an in-process loop).

## Timing

| Constant | Default | Meaning |
|----------|---------|---------|
| `INITIAL_HEX_RING` | 0 | Pickup H3 cell only (res 8) |
| `HEX_RING_EXPAND` | 1 | Grow one ring per empty tick |
| `MAX_HEX_RING` | 7 | Stop expanding; unmatched if still empty |
| `INITIAL_RADIUS_KM` | ~1.0 | GEO fallback radius covering ring 0 |
| `MAX_RADIUS_KM` | ~7.4 | GEO fallback covering max ring |
| `OFFER_TIMEOUT_MS` | 2 min | Driver accept window |
| `MAX_DISPATCH_MS` | 6 min | Overall attempt budget |

## Jobs

| Type | Purpose |
|------|---------|
| `tick` | Offer to next eligible driver, expand H3 ring, or unmatched |
| `offer_check` | After offer TTL: release driver → next `tick` |

State (`startedAt`, `hexRing`, `radiusKm`, `triedDriverIds`) lives in
`ride:dispatch:state:{rideId}` so jobs resume after process restart.

## Flow

1. `POST /rides` → `DispatchQueueService.enqueueDispatch`
2. Interval drain (~1s) claims due job ids from `ride:dispatch:due`
3. Each tick queries location-svc `POST /drivers/nearby-zones` with
   `gridDisk(pickup, hexRing)`, then GEO `/drivers/nearby`, then Postgres
4. Accept / decline / cancel clear or continue the queue
5. Empty pool at `MAX_HEX_RING` → `UNMATCHED` → rider sees **Retry**
6. Driver cancel (pre-trip) → rematch: same ride id, SEARCHING, skip prior driver
7. On boot, SEARCHING/OFFERED rides within the dispatch window are re-queued

## Surge demand

Live demand is keyed by **riderId** (one member per hex). Retries refresh the
same member; unmatched releases only when the rider has no other active search.
Dispatch hex rings and demand heat share the same H3 resolution (8).

## Keys

- `ride:dispatch:due` — ZSET score = run-at ms
- `ride:dispatch:job:{id}` — job JSON
- `ride:dispatch:state:{rideId}` — search progress
- `ride:offer:driver:{driverId}` — short offer lock
- `demand:supply:{zoneId}` — available drivers per hex (location-svc)
