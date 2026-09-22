# Ride dispatch queue

On-demand matching uses a **Redis delayed job** queue (not an in-process loop).

## Timing

| Constant | Default | Meaning |
|----------|---------|---------|
| `INITIAL_RADIUS_KM` | 1.5 | First nearby search |
| `RADIUS_EXPAND_KM` | 1.5 | Grow each empty tick |
| `MAX_RADIUS_KM` | 8 | Stop expanding; unmatched if still empty |
| `OFFER_TIMEOUT_MS` | 2 min | Driver accept window |
| `MAX_DISPATCH_MS` | 6 min | Overall attempt budget |

## Jobs

| Type | Purpose |
|------|---------|
| `tick` | Offer to next eligible driver, expand radius, or unmatched |
| `offer_check` | After offer TTL: release driver → next `tick` |

State (`startedAt`, `radiusKm`, `triedDriverIds`) lives in
`ride:dispatch:state:{rideId}` so jobs resume after process restart.

## Flow

1. `POST /rides` → `DispatchQueueService.enqueueDispatch`
2. Interval drain (~1s) claims due job ids from `ride:dispatch:due`
3. Accept / decline / cancel clear or continue the queue
4. Empty pool at `MAX_RADIUS_KM` → `UNMATCHED` → rider sees **Retry**
5. On boot, SEARCHING/OFFERED rides within the dispatch window are re-queued

## Surge demand

Live demand is keyed by **riderId** (one member per hex). Retries refresh the
same member; unmatched releases only when the rider has no other active search.

## Keys

- `ride:dispatch:due` — ZSET score = run-at ms
- `ride:dispatch:job:{id}` — job JSON
- `ride:dispatch:state:{rideId}` — search progress
- `ride:offer:driver:{driverId}` — short offer lock
