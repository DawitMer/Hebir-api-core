package demand

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// windowDuration is the sliding window used to estimate live demand.
// Short enough to react to a sudden spike, long enough to avoid
// flapping the surge multiplier between requests seconds apart.
const windowDuration = 5 * time.Minute

// CellSizeDegrees must match handlers.zoneIDFor / api-core geo.util.
const CellSizeDegrees = 0.02

// Tracker maintains a rough per-zone ratio of waiting riders to available
// drivers, used by api-core's fare module to price surge (blueprint's
// demand-based pricing requirement).
type Tracker struct {
	redis *redis.Client
}

func NewTracker(client *redis.Client) *Tracker {
	return &Tracker{redis: client}
}

func (t *Tracker) RecordRiderRequest(ctx context.Context, zoneID string) error {
	return t.increment(ctx, riderKey(zoneID))
}

// RecordDriverAvailable counts DISTINCT drivers, not pings. Drivers report GPS
// roughly every 12s, so incrementing a counter per ping made "supply" scale
// with ping rate: one driver looked like hundreds and the demand ratio never
// rose above 1, so surge never engaged during a real shortage.
func (t *Tracker) RecordDriverAvailable(ctx context.Context, zoneID, driverID string) error {
	if driverID == "" {
		return nil
	}
	key := driverSetKey(zoneID)
	// Refresh the window on every ping, not just on first-add: supply should
	// live one window past the last ping. Refreshing only on new members let
	// the set expire while drivers were still pinging, collapsing supply to
	// zero each window and spiking surge for no reason.
	pipe := t.redis.TxPipeline()
	pipe.SAdd(ctx, key, driverID)
	pipe.Expire(ctx, key, windowDuration)
	_, err := pipe.Exec(ctx)
	return err
}

// RemoveDriver drops a driver from every zone supply set (explicit
// go-offline), so an offline driver stops counting as supply immediately
// instead of suppressing surge until the window expires.
func (t *Tracker) RemoveDriver(ctx context.Context, driverID string) error {
	if driverID == "" {
		return nil
	}
	var cursor uint64
	for {
		keys, next, err := t.redis.Scan(ctx, cursor, "demand:driverset:*", 100).Result()
		if err != nil {
			return err
		}
		for _, key := range keys {
			if err := t.redis.SRem(ctx, key, driverID).Err(); err != nil {
				return err
			}
		}
		cursor = next
		if cursor == 0 {
			return nil
		}
	}
}

// increment counts one signal in the current window. The TTL is only set when
// the counter is created: refreshing it on every increment turned the window
// into "as long as this zone stays busy", so a busy zone's rider count grew
// without bound and its surge ratio never came back down.
func (t *Tracker) increment(ctx context.Context, key string) error {
	count, err := t.redis.Incr(ctx, key).Result()
	if err != nil {
		return err
	}
	if count == 1 {
		return t.redis.Expire(ctx, key, windowDuration).Err()
	}
	return nil
}

// DemandRatio returns riders-waiting / drivers-available for a zone.
// A ratio near or below 1 means no surge; above 1 means demand exceeds
// supply. The fare module clamps this at a configurable ceiling.
func (t *Tracker) DemandRatio(ctx context.Context, zoneID string) (float64, error) {
	riders, err := t.redis.Get(ctx, riderKey(zoneID)).Int64()
	if err != nil && err != redis.Nil {
		return 0, err
	}
	drivers, err := t.driverCount(ctx, zoneID)
	if err != nil {
		return 0, err
	}
	if drivers < 1 {
		drivers = 1
	}
	return float64(riders) / float64(drivers), nil
}

// driverCount is the number of distinct drivers seen in the zone this window.
func (t *Tracker) driverCount(ctx context.Context, zoneID string) (int64, error) {
	count, err := t.redis.SCard(ctx, driverSetKey(zoneID)).Result()
	if err != nil && err != redis.Nil {
		return 0, err
	}
	return count, nil
}

// Cell is one demand grid cell for heatmap / busy-area map tint.
type Cell struct {
	ZoneID      string  `json:"zoneId"`
	Lat         float64 `json:"lat"`
	Lng         float64 `json:"lng"`
	Riders      int64   `json:"riders"`
	Drivers     int64   `json:"drivers"`
	DemandRatio float64 `json:"demandRatio"`
}

// Grid scans Redis demand keys and returns cells that intersect the bbox.
func (t *Tracker) Grid(ctx context.Context, minLat, minLng, maxLat, maxLng float64) ([]Cell, error) {
	zones := map[string]struct{}{}
	if err := t.scanZones(ctx, "demand:riders:*", zones); err != nil {
		return nil, err
	}
	if err := t.scanZones(ctx, "demand:driverset:*", zones); err != nil {
		return nil, err
	}

	out := make([]Cell, 0, len(zones))
	for zoneID := range zones {
		lat, lng, ok := zoneCenter(zoneID)
		if !ok {
			continue
		}
		if lat < minLat || lat > maxLat || lng < minLng || lng > maxLng {
			continue
		}
		riders, err := t.redis.Get(ctx, riderKey(zoneID)).Int64()
		if err != nil && err != redis.Nil {
			return nil, err
		}
		drivers, err := t.driverCount(ctx, zoneID)
		if err != nil {
			return nil, err
		}
		denom := drivers
		if denom < 1 {
			denom = 1
		}
		out = append(out, Cell{
			ZoneID:      zoneID,
			Lat:         lat,
			Lng:         lng,
			Riders:      riders,
			Drivers:     drivers,
			DemandRatio: float64(riders) / float64(denom),
		})
	}
	return out, nil
}

func (t *Tracker) scanZones(ctx context.Context, pattern string, zones map[string]struct{}) error {
	var cursor uint64
	for {
		keys, next, err := t.redis.Scan(ctx, cursor, pattern, 100).Result()
		if err != nil {
			return err
		}
		for _, key := range keys {
			zoneID := zoneIDFromKey(key)
			if zoneID != "" {
				zones[zoneID] = struct{}{}
			}
		}
		cursor = next
		if cursor == 0 {
			break
		}
	}
	return nil
}

func zoneIDFromKey(key string) string {
	// demand:riders:z:lat:lng  or  demand:driverset:z:lat:lng
	parts := strings.SplitN(key, ":", 3)
	if len(parts) < 3 {
		return ""
	}
	return parts[2]
}

func zoneCenter(zoneID string) (lat, lng float64, ok bool) {
	parts := strings.Split(zoneID, ":")
	if len(parts) != 3 || parts[0] != "z" {
		return 0, 0, false
	}
	latCell, err1 := strconv.Atoi(parts[1])
	lngCell, err2 := strconv.Atoi(parts[2])
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return (float64(latCell) + 0.5) * CellSizeDegrees,
		(float64(lngCell) + 0.5) * CellSizeDegrees,
		true
}

func riderKey(zoneID string) string {
	return fmt.Sprintf("demand:riders:%s", zoneID)
}

// driverSetKey holds distinct driver ids. Deliberately a different key from the
// old demand:drivers:* counters so a rolling deploy cannot hit WRONGTYPE.
func driverSetKey(zoneID string) string {
	return fmt.Sprintf("demand:driverset:%s", zoneID)
}
