package demand

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// WindowDuration is how long a distinct rider/driver stays in the live set
// without a refresh. Short enough to clear stale demand; long enough to avoid
// flapping between GPS pings.
const WindowDuration = 5 * time.Minute

// H3Resolution documents the Uber H3 resolution used by api-core (h3-js).
// location-svc stores opaque zone ids; it does not compute H3 itself (CGO-free).
const H3Resolution = 8

// ApproxHexRadiusM ≈ H3 res-8 average edge length — used only for map polygons
// when the caller did not send a boundary.
const ApproxHexRadiusM = 461.0

// CellSizeDegrees is retained only for parsing legacy z:lat:lng keys.
const CellSizeDegrees = 0.02

// Tracker maintains per-hex live marketplace counts for surge pricing.
// Zone ids are Uber H3 indexes produced by api-core (must stay in sync).
type Tracker struct {
	redis *redis.Client
	cfg   Config
}

func NewTracker(client *redis.Client) *Tracker {
	return &Tracker{redis: client, cfg: DefaultConfig()}
}

func (t *Tracker) WithConfig(cfg Config) *Tracker {
	t.cfg = cfg
	return t
}

// ZoneIDFor is a legacy square-grid fallback when callers omit an H3 id.
// Prefer the H3 zoneId computed in api-core.
func ZoneIDFor(lat, lng float64) string {
	latCell := int(math.Floor(lat / CellSizeDegrees))
	lngCell := int(math.Floor(lng / CellSizeDegrees))
	return fmt.Sprintf("z:%d:%d", latCell, lngCell)
}

// RecordRiderActive adds/refreshes one distinct rider in the hex.
// Re-requesting the same riderId does not inflate the count.
func (t *Tracker) RecordRiderActive(ctx context.Context, zoneID, riderID string, lat, lng float64) error {
	if riderID == "" || zoneID == "" {
		return nil
	}
	if err := t.rememberCentroid(ctx, zoneID, lat, lng); err != nil {
		return err
	}
	return t.touchMember(ctx, riderKey(zoneID), riderID)
}

// ReleaseRider removes a rider from every active-demand set (cancel / match /
// complete / unmatched). Demand must drop when the request leaves the market.
func (t *Tracker) ReleaseRider(ctx context.Context, riderID string) error {
	if riderID == "" {
		return nil
	}
	return t.removeFromPattern(ctx, "demand:active:*", riderID)
}

// RecordDriverAvailable counts DISTINCT online idle drivers only.
func (t *Tracker) RecordDriverAvailable(ctx context.Context, zoneID, driverID string, lat, lng float64) error {
	if driverID == "" || zoneID == "" {
		return nil
	}
	if err := t.removeFromPattern(ctx, "demand:supply:*", driverID); err != nil {
		return err
	}
	_ = t.removeFromPattern(ctx, "demand:busy:*", driverID)
	if err := t.rememberCentroid(ctx, zoneID, lat, lng); err != nil {
		return err
	}
	return t.touchMember(ctx, supplyKey(zoneID), driverID)
}

// RecordDriverBusy marks an on-trip / reserved driver: not available supply.
func (t *Tracker) RecordDriverBusy(ctx context.Context, zoneID, driverID string, lat, lng float64) error {
	if driverID == "" {
		return nil
	}
	if err := t.removeFromPattern(ctx, "demand:supply:*", driverID); err != nil {
		return err
	}
	if zoneID != "" {
		_ = t.rememberCentroid(ctx, zoneID, lat, lng)
		return t.touchMember(ctx, busyKey(zoneID), driverID)
	}
	return nil
}

// RemoveDriver drops a driver from every supply/busy set (go offline).
func (t *Tracker) RemoveDriver(ctx context.Context, driverID string) error {
	if driverID == "" {
		return nil
	}
	if err := t.removeFromPattern(ctx, "demand:supply:*", driverID); err != nil {
		return err
	}
	return t.removeFromPattern(ctx, "demand:busy:*", driverID)
}

// RecordRiderRequest is a no-op: anonymous increments are rejected so browse
// traffic and corridor polls cannot fabricate surge.
func (t *Tracker) RecordRiderRequest(ctx context.Context, zoneID string) error {
	_ = ctx
	_ = zoneID
	return nil
}

func (t *Tracker) rememberCentroid(ctx context.Context, zoneID string, lat, lng float64) error {
	if !validLatLng(lat, lng) {
		return nil
	}
	payload, _ := json.Marshal(LatLng{Lat: lat, Lng: lng})
	return t.redis.Set(ctx, metaKey(zoneID), payload, WindowDuration+time.Minute).Err()
}

func (t *Tracker) touchMember(ctx context.Context, key, member string) error {
	exp := float64(time.Now().Add(WindowDuration).Unix())
	now := float64(time.Now().Unix())
	pipe := t.redis.TxPipeline()
	pipe.ZRemRangeByScore(ctx, key, "-inf", fmt.Sprintf("%f", now))
	pipe.ZAdd(ctx, key, redis.Z{Score: exp, Member: member})
	pipe.Expire(ctx, key, WindowDuration+time.Minute)
	_, err := pipe.Exec(ctx)
	return err
}

func (t *Tracker) removeFromPattern(ctx context.Context, pattern, member string) error {
	var cursor uint64
	for {
		keys, next, err := t.redis.Scan(ctx, cursor, pattern, 100).Result()
		if err != nil {
			return err
		}
		for _, key := range keys {
			if err := t.redis.ZRem(ctx, key, member).Err(); err != nil {
				return err
			}
		}
		cursor = next
		if cursor == 0 {
			return nil
		}
	}
}

func (t *Tracker) countFresh(ctx context.Context, key string) (int64, error) {
	now := float64(time.Now().Unix())
	if err := t.redis.ZRemRangeByScore(ctx, key, "-inf", fmt.Sprintf("%f", now)).Err(); err != nil {
		return 0, err
	}
	n, err := t.redis.ZCard(ctx, key).Result()
	if err == redis.Nil {
		return 0, nil
	}
	return n, err
}

// Snapshot is live hex marketplace state.
type Snapshot struct {
	ZoneID          string   `json:"zoneId"`
	Lat             float64  `json:"lat"`
	Lng             float64  `json:"lng"`
	Riders          int64    `json:"riders"`
	Drivers         int64    `json:"drivers"`
	BusyDrivers     int64    `json:"busyDrivers"`
	DemandRatio     float64  `json:"demandRatio"`
	SurgeMultiplier float64  `json:"surgeMultiplier"`
	Boundary        []LatLng `json:"boundary,omitempty"`
	UpdatedAtUnix   int64    `json:"updatedAt"`
}

type LatLng struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

// Cell is the grid payload (alias of Snapshot for handlers).
type Cell = Snapshot

func (t *Tracker) ZoneSnapshot(ctx context.Context, zoneID string) (Snapshot, error) {
	riders, err := t.countFresh(ctx, riderKey(zoneID))
	if err != nil {
		return Snapshot{}, err
	}
	drivers, err := t.countFresh(ctx, supplyKey(zoneID))
	if err != nil {
		return Snapshot{}, err
	}
	busy, err := t.countFresh(ctx, busyKey(zoneID))
	if err != nil {
		return Snapshot{}, err
	}

	prev, _ := t.redis.Get(ctx, prevSurgeKey(zoneID)).Float64()
	neighborAvg := t.neighborAverageTarget(ctx, zoneID)
	result := ComputeLiveSurge(riders, drivers, prev, neighborAvg, t.cfg)
	_ = t.redis.Set(ctx, prevSurgeKey(zoneID), result.Multiplier, WindowDuration).Err()

	lat, lng := t.centroid(ctx, zoneID)
	return Snapshot{
		ZoneID:          zoneID,
		Lat:             lat,
		Lng:             lng,
		Riders:          riders,
		Drivers:         drivers,
		BusyDrivers:     busy,
		DemandRatio:     result.DemandRatio,
		SurgeMultiplier: result.Multiplier,
		Boundary:        approxHexBoundary(lat, lng),
		UpdatedAtUnix:   time.Now().Unix(),
	}, nil
}

func (t *Tracker) DemandRatio(ctx context.Context, zoneID string) (float64, error) {
	snap, err := t.ZoneSnapshot(ctx, zoneID)
	if err != nil {
		return 0, err
	}
	return snap.DemandRatio, nil
}

func (t *Tracker) centroid(ctx context.Context, zoneID string) (float64, float64) {
	raw, err := t.redis.Get(ctx, metaKey(zoneID)).Bytes()
	if err == nil {
		var p LatLng
		if json.Unmarshal(raw, &p) == nil && validLatLng(p.Lat, p.Lng) {
			return p.Lat, p.Lng
		}
	}
	if strings.HasPrefix(zoneID, "z:") {
		parts := strings.Split(zoneID, ":")
		if len(parts) == 3 {
			latCell, err1 := strconv.Atoi(parts[1])
			lngCell, err2 := strconv.Atoi(parts[2])
			if err1 == nil && err2 == nil {
				return (float64(latCell) + 0.5) * CellSizeDegrees,
					(float64(lngCell) + 0.5) * CellSizeDegrees
			}
		}
	}
	return 0, 0
}

// neighborAverageTarget averages target multipliers of zones that share a
// coarse lat/lng neighborhood (~1.2 km). Full H3 k-ring smoothing is applied
// in api-core when enriching fare; this keeps map cells from looking binary.
func (t *Tracker) neighborAverageTarget(ctx context.Context, zoneID string) float64 {
	lat, lng := t.centroid(ctx, zoneID)
	if !validLatLng(lat, lng) {
		return 1
	}
	zones := map[string]struct{}{}
	_ = t.scanZones(ctx, "demand:active:*", zones)
	_ = t.scanZones(ctx, "demand:supply:*", zones)

	var sum float64
	var n int
	for id := range zones {
		if id == zoneID {
			continue
		}
		olat, olng := t.centroid(ctx, id)
		if !validLatLng(olat, olng) {
			continue
		}
		if haversineM(lat, lng, olat, olng) > 1200 {
			continue
		}
		riders, err1 := t.countFresh(ctx, riderKey(id))
		drivers, err2 := t.countFresh(ctx, supplyKey(id))
		if err1 != nil || err2 != nil {
			continue
		}
		r := ComputeLiveSurge(riders, drivers, 1, 1, t.cfg)
		sum += r.TargetMultiplier
		n++
	}
	if n == 0 {
		return 1
	}
	return sum / float64(n)
}

// Grid returns hex cells that intersect the bbox and have live rider demand.
// Supply-only cells are omitted so the map never shows fake surge zones.
func (t *Tracker) Grid(ctx context.Context, minLat, minLng, maxLat, maxLng float64) ([]Cell, error) {
	zones := map[string]struct{}{}
	if err := t.scanZones(ctx, "demand:active:*", zones); err != nil {
		return nil, err
	}
	if err := t.scanZones(ctx, "demand:supply:*", zones); err != nil {
		return nil, err
	}

	out := make([]Cell, 0, len(zones))
	for zoneID := range zones {
		snap, err := t.ZoneSnapshot(ctx, zoneID)
		if err != nil {
			return nil, err
		}
		if snap.Lat < minLat || snap.Lat > maxLat || snap.Lng < minLng || snap.Lng > maxLng {
			continue
		}
		if snap.Riders <= 0 {
			continue
		}
		out = append(out, snap)
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
	parts := strings.SplitN(key, ":", 3)
	if len(parts) < 3 {
		return ""
	}
	return parts[2]
}

func approxHexBoundary(lat, lng float64) []LatLng {
	if !validLatLng(lat, lng) {
		return nil
	}
	out := make([]LatLng, 0, 6)
	for i := 0; i < 6; i++ {
		bearing := float64(i)*60.0 - 30.0 // flat-top hex
		out = append(out, destinationPoint(lat, lng, ApproxHexRadiusM, bearing))
	}
	return out
}

func destinationPoint(lat, lng, distM, bearingDeg float64) LatLng {
	const r = 6371000.0
	δ := distM / r
	θ := bearingDeg * math.Pi / 180
	φ1 := lat * math.Pi / 180
	λ1 := lng * math.Pi / 180
	sinφ1, cosφ1 := math.Sin(φ1), math.Cos(φ1)
	sinδ, cosδ := math.Sin(δ), math.Cos(δ)
	sinφ2 := sinφ1*cosδ + cosφ1*sinδ*math.Cos(θ)
	φ2 := math.Asin(sinφ2)
	λ2 := λ1 + math.Atan2(math.Sin(θ)*sinδ*cosφ1, cosδ-sinφ1*sinφ2)
	return LatLng{Lat: φ2 * 180 / math.Pi, Lng: λ2 * 180 / math.Pi}
}

func haversineM(lat1, lng1, lat2, lng2 float64) float64 {
	const r = 6371000.0
	toRad := math.Pi / 180
	dLat := (lat2 - lat1) * toRad
	dLng := (lng2 - lng1) * toRad
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*toRad)*math.Cos(lat2*toRad)*math.Sin(dLng/2)*math.Sin(dLng/2)
	return 2 * r * math.Asin(math.Min(1, math.Sqrt(a)))
}

func validLatLng(lat, lng float64) bool {
	return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 &&
		!(lat == 0 && lng == 0)
}

func riderKey(zoneID string) string     { return fmt.Sprintf("demand:active:%s", zoneID) }
func supplyKey(zoneID string) string    { return fmt.Sprintf("demand:supply:%s", zoneID) }
func busyKey(zoneID string) string      { return fmt.Sprintf("demand:busy:%s", zoneID) }
func metaKey(zoneID string) string      { return fmt.Sprintf("demand:meta:%s", zoneID) }
func prevSurgeKey(zoneID string) string { return fmt.Sprintf("demand:prevsurge:%s", zoneID) }
