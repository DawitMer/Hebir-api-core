# Ride dispatch queue

On-demand matching no longer runs an in-process `while` loop for the full
75s search window (or 15s offer wait). Each step is a **Redis delayed job**.

## Jobs

| Type | Purpose |
|------|---------|
| `tick` | Find next eligible driver at current radius, or expand radius |
| `offer_check` | After offer TTL: timeout → release driver → enqueue next `tick` |

State (`startedAt`, `radiusKm`, `triedDriverIds`) lives in
`ride:dispatch:state:{rideId}` so jobs resume after process restart.

## Flow

1. `POST /rides` → `DispatchQueueService.enqueueDispatch`
2. Interval drain (~1s) claims due job ids from `ride:dispatch:due`
3. Accept / decline / cancel clear or continue the queue
4. On boot, SEARCHING/OFFERED rides within the dispatch window are re-queued

## Keys

- `ride:dispatch:due` — ZSET score = run-at ms
- `ride:dispatch:job:{id}` — job JSON
- `ride:dispatch:state:{rideId}` — search progress
- `ride:offer:driver:{driverId}` — short offer lock (unchanged)
