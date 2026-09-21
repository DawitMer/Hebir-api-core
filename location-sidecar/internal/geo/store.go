package geo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// MaxRadiusKm bounds any radius query; Addis fits comfortably inside it and it
// stops a caller from asking Redis to sort the entire national index.
const MaxRadiusKm = 100

// ErrInvalidPoint is returned for coordinates Redis GEO cannot index.
var ErrInvalidPoint = errors.New("lat must be in [-85.05112878, 85.05112878] and lng in [-180, 180]")

// ValidPoint reports whether a point is inside the range Redis GEO accepts.
// An out-of-range or NaN coordinate otherwise surfaces as a Redis error and a
// 500 from an endpoint that should have answered 400.
func ValidPoint(p Point) bool {
	if math.IsNaN(p.Lat) || math.IsNaN(p.Lng) ||
		math.IsInf(p.Lat, 0) || math.IsInf(p.Lng, 0) {
		return false
	}
	return p.Lat >= -85.05112878 && p.Lat <= 85.05112878 &&
		p.Lng >= -180 && p.Lng <= 180
}

// ClampRadiusKm normalises a requested radius into (0, MaxRadiusKm].
func ClampRadiusKm(radiusKm, fallback float64) float64 {
	if math.IsNaN(radiusKm) || radiusKm <= 0 {
		radiusKm = fallback
	}
	if radiusKm > MaxRadiusKm {
		return MaxRadiusKm
	}
	return radiusKm
}

const routePointsKey = "trip_route_points"
const tripRouteMembersPrefix = "trip_route_members:"

func tripRouteMembersKey(tripID string) string {
	return tripRouteMembersPrefix + tripID
}

// Point is a lat/lng pair matching the GeoPoint shape used by api-core.
type Point struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

// Trip is the subset of api-core's Trip entity this service needs to index.
type Trip struct {
	ID             string  `json:"id"`
	StartPoint     Point   `json:"startPoint"`
	Destination    Point   `json:"destination"`
	RoutePath      []Point `json:"routePath"`
	InMatchingPool bool    `json:"inMatchingPool"`
}

// Store indexes trip routes in Redis so a corridor search only ever scans
// nearby geography instead of every trip nationwide.
type Store struct {
	redis *redis.Client
	// maxAge is the same freshness bound used by the staleness sweeper;
	// driver queries drop members whose last ping is older than this so a
	// crashed app stops being dispatchable before the next sweep runs.
	maxAge time.Duration
}

func NewStore(client *redis.Client, maxAge time.Duration) *Store {
	return &Store{redis: client, maxAge: maxAge}
}

// IndexTrip adds every point on the trip's route to a shared geo-index.
// Existing points for the trip are pruned first so a shorter re-index cannot
// leave orphan members from a previous longer route.
func (s *Store) IndexTrip(ctx context.Context, trip Trip) error {
	if err := s.RemoveTrip(ctx, trip.ID); err != nil {
		return err
	}

	points := trip.RoutePath
	if len(points) == 0 {
		points = []Point{trip.StartPoint, trip.Destination}
	}

	members := make([]*redis.GeoLocation, 0, len(points))
	names := make([]interface{}, 0, len(points))
	for i, p := range points {
		name := fmt.Sprintf("%s:%d", trip.ID, i)
		members = append(members, &redis.GeoLocation{
			Name:      name,
			Longitude: p.Lng,
			Latitude:  p.Lat,
		})
		names = append(names, name)
	}

	pipe := s.redis.TxPipeline()
	pipe.GeoAdd(ctx, routePointsKey, members...)
	pipe.SAdd(ctx, tripRouteMembersKey(trip.ID), names...)
	_, err := pipe.Exec(ctx)
	return err
}

// RemoveTrip drops a trip's points from the index (e.g. once it is full
// or the driver's subscription lapses and it leaves the matching pool).
func (s *Store) RemoveTrip(ctx context.Context, tripID string) error {
	key := tripRouteMembersKey(tripID)
	members, err := s.redis.SMembers(ctx, key).Result()
	if err != nil {
		return err
	}
	if len(members) == 0 {
		_ = s.redis.Del(ctx, key).Err()
		return nil
	}
	args := make([]interface{}, len(members))
	for i, m := range members {
		args[i] = m
	}
	pipe := s.redis.TxPipeline()
	pipe.ZRem(ctx, routePointsKey, args...)
	pipe.Del(ctx, key)
	_, err = pipe.Exec(ctx)
	return err
}

// CorridorSearch returns trip IDs whose route passes within corridorWidthKm
// of BOTH the pickup and the drop-off point, in that relative order. This
// is Layer 2 of the matching pipeline (blueprint 6.7).
func (s *Store) CorridorSearch(ctx context.Context, pickup, dropoff Point, corridorWidthKm float64) ([]string, error) {
	radiusKm := corridorWidthKm / 2

	nearPickup, err := s.tripsNear(ctx, pickup, radiusKm)
	if err != nil {
		return nil, err
	}
	nearDropoff, err := s.tripsNear(ctx, dropoff, radiusKm)
	if err != nil {
		return nil, err
	}

	var result []string
	for tripID, pickupIdx := range nearPickup {
		dropoffIdx, ok := nearDropoff[tripID]
		if !ok {
			continue
		}
		// Enforce pickup→dropoff order along the route: some point near the
		// pickup must precede some point near the dropoff, otherwise the trip
		// passes both places in the wrong direction.
		if pickupIdx.min < dropoffIdx.max {
			result = append(result, tripID)
		}
	}
	return result, nil
}

const driverLocationsKey = "driver_locations"

// driverSeenKey scores each driver by the time of their last ping. Redis GEO
// entries carry no TTL of their own, so without this a driver who goes offline
// or whose app crashes stays "nearby" forever and keeps winning dispatch.
const driverSeenKey = "driver_locations:seen"

// driverMetaKey holds heading/speed/accuracy/timestamp per driver. GEO only
// stores the point; the rider map needs the rest to interpolate without polling
// a second store.
const driverMetaKey = "driver_locations:meta"

// backfillScanLimit bounds how many indexed members one backfill pass inspects.
const backfillScanLimit = 5000

// MaxNearestDrivers caps a dispatch candidate lookup.
const MaxNearestDrivers = 250

// maxRoutePointsPerSearch caps one corridor GeoRadius so a wide corridor over a
// large index cannot return an unbounded member set.
const maxRoutePointsPerSearch = 2000

// DriverLocation is a live GPS sample from the Redis geo index plus the
// kinematic fields the rider map uses to interpolate between pings.
type DriverLocation struct {
	DriverID     string   `json:"driverId"`
	Lat          float64  `json:"lat"`
	Lng          float64  `json:"lng"`
	Heading      *float64 `json:"heading,omitempty"`
	Speed        *float64 `json:"speed,omitempty"`
	Accuracy     *float64 `json:"accuracy,omitempty"`
	TimestampMs  int64    `json:"timestampMs,omitempty"`
}

// Ping is one device GPS sample waiting to enter the live index.
type Ping struct {
	Point
	Heading  *float64
	Speed    *float64
	Accuracy *float64
}

// UpdateResult tells the caller whether the GEO index moved. Rejected pings
// still refresh the seen-set so a noisy device is not evicted as stale.
type UpdateResult struct {
	Accepted bool   `json:"accepted"`
	Reason   string `json:"reason,omitempty"`
	DriverLocation
}

// UpdateDriverLocation records a driver's latest GPS ping after a jump gate.
// Matching's nearest-driver queries read from this same GEO set.
func (s *Store) UpdateDriverLocation(ctx context.Context, driverID string, ping Ping) (UpdateResult, error) {
	now := time.Now()
	prev, _ := s.loadMeta(ctx, driverID)
	ok, reason := AcceptPing(prev, ping.Point, ping.Accuracy, now)

	// Always refresh liveness: a rejected sample still means the app is alive.
	seen := redis.Z{Score: float64(now.UnixMilli()), Member: driverID}

	if !ok {
		_, _ = s.redis.ZAdd(ctx, driverSeenKey, seen).Result()
		out := UpdateResult{Accepted: false, Reason: reason}
		if prev != nil {
			out.DriverLocation = *prev
			out.DriverID = driverID
		} else {
			out.DriverID = driverID
			out.Lat = ping.Lat
			out.Lng = ping.Lng
		}
		return out, nil
	}

	loc := DriverLocation{
		DriverID:    driverID,
		Lat:         ping.Lat,
		Lng:         ping.Lng,
		Heading:     ping.Heading,
		Speed:       ping.Speed,
		Accuracy:    ping.Accuracy,
		TimestampMs: now.UnixMilli(),
	}
	raw, err := json.Marshal(loc)
	if err != nil {
		return UpdateResult{}, err
	}

	pipe := s.redis.TxPipeline()
	pipe.GeoAdd(ctx, driverLocationsKey, &redis.GeoLocation{
		Name:      driverID,
		Longitude: ping.Lng,
		Latitude:  ping.Lat,
	})
	pipe.ZAdd(ctx, driverSeenKey, seen)
	pipe.HSet(ctx, driverMetaKey, driverID, raw)
	if _, err := pipe.Exec(ctx); err != nil {
		return UpdateResult{}, err
	}
	return UpdateResult{Accepted: true, DriverLocation: loc}, nil
}

// GetDriver returns one indexed driver, or nil when they are not in the live set.
func (s *Store) GetDriver(ctx context.Context, driverID string) (*DriverLocation, error) {
	if driverID == "" {
		return nil, nil
	}
	positions, err := s.redis.GeoPos(ctx, driverLocationsKey, driverID).Result()
	if err != nil {
		return nil, err
	}
	if len(positions) == 0 || positions[0] == nil {
		return nil, nil
	}
	score, err := s.redis.ZScore(ctx, driverSeenKey, driverID).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	cutoff := float64(time.Now().Add(-s.maxAge).UnixMilli())
	if score < cutoff {
		return nil, nil
	}
	loc := DriverLocation{
		DriverID: driverID,
		Lat:      positions[0].Latitude,
		Lng:      positions[0].Longitude,
	}
	if meta, _ := s.loadMeta(ctx, driverID); meta != nil {
		loc.Heading = meta.Heading
		loc.Speed = meta.Speed
		loc.Accuracy = meta.Accuracy
		loc.TimestampMs = meta.TimestampMs
	}
	return &loc, nil
}

// RemoveDriver drops a driver from the live index (explicit go-offline).
func (s *Store) RemoveDriver(ctx context.Context, driverID string) error {
	pipe := s.redis.TxPipeline()
	pipe.ZRem(ctx, driverLocationsKey, driverID)
	pipe.ZRem(ctx, driverSeenKey, driverID)
	pipe.HDel(ctx, driverMetaKey, driverID)
	_, err := pipe.Exec(ctx)
	return err
}

// evictStaleScript only removes a driver when their seen score is still below
// cutoff, so a ping that lands after ZRANGEBYSCORE cannot be wiped.
var evictStaleScript = redis.NewScript(`
local seen = KEYS[1]
local geo = KEYS[2]
local meta = KEYS[3]
local cutoff = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local stale = redis.call('ZRANGEBYSCORE', seen, '-inf', cutoff, 'LIMIT', 0, limit)
local n = 0
for _, id in ipairs(stale) do
  local score = redis.call('ZSCORE', seen, id)
  if score and tonumber(score) < cutoff then
    redis.call('ZREM', seen, id)
    redis.call('ZREM', geo, id)
    redis.call('HDEL', meta, id)
    n = n + 1
  end
end
return n
`)

// EvictStaleDrivers removes drivers whose last ping is older than maxAge and
// returns how many were dropped. Called on a ticker from main.
func (s *Store) EvictStaleDrivers(ctx context.Context, maxAge time.Duration) (int, error) {
	if err := s.backfillSeen(ctx, maxAge); err != nil {
		return 0, err
	}

	cutoff := time.Now().Add(-maxAge).UnixMilli()
	n, err := evictStaleScript.Run(ctx, s.redis, []string{driverSeenKey, driverLocationsKey, driverMetaKey}, cutoff, 1000).Int()
	if err != nil {
		return 0, err
	}
	return n, nil
}

// backfillSeen gives an age to drivers indexed before the seen-set existed
// (or added by a writer that skipped it) so they can age out normally instead
// of lingering in the index forever.
func (s *Store) backfillSeen(ctx context.Context, maxAge time.Duration) error {
	indexed, err := s.redis.ZCard(ctx, driverLocationsKey).Result()
	if err != nil {
		return err
	}
	seen, err := s.redis.ZCard(ctx, driverSeenKey).Result()
	if err != nil {
		return err
	}
	if indexed <= seen {
		return nil
	}

	members, err := s.redis.ZRange(ctx, driverLocationsKey, 0, backfillScanLimit-1).Result()
	if err != nil || len(members) == 0 {
		return err
	}
	scores, err := s.redis.ZMScore(ctx, driverSeenKey, members...).Result()
	if err != nil {
		return err
	}

	// Stamp unknown members as already stale (now - maxAge) so the next sweep
	// evicts them. Stamping "now" would grant a zombie member a fresh TTL on
	// every discovery, keeping it in the index forever.
	stale := float64(time.Now().Add(-maxAge).UnixMilli())
	missing := make([]redis.Z, 0, len(members))
	for i, member := range members {
		if i < len(scores) && scores[i] != 0 {
			continue
		}
		missing = append(missing, redis.Z{Score: stale, Member: member})
	}
	if len(missing) == 0 {
		return nil
	}
	return s.redis.ZAdd(ctx, driverSeenKey, missing...).Err()
}

// NearestDrivers returns driver IDs within radiusKm of a point, closest
// first. The cap is generous because api-core filters the result again by
// online status and active subscription: a tight cap here (it used to be 50)
// meant a busy rank could fill every slot with ineligible drivers and dispatch
// would offer to nobody.
func (s *Store) NearestDrivers(ctx context.Context, point Point, radiusKm float64, limit int) ([]string, error) {
	if limit <= 0 || limit > MaxNearestDrivers {
		limit = MaxNearestDrivers
	}
	locations, err := s.DriversNear(ctx, point, radiusKm, limit)
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(locations))
	for i, loc := range locations {
		ids[i] = loc.DriverID
	}
	return ids, nil
}

// DriversNear returns drivers within radiusKm of a point, with coordinates.
// Candidates whose last ping is older than the sweeper's maxAge are dropped
// at query time: GEO membership alone would keep a crashed app dispatchable
// until the next sweep runs.
func (s *Store) DriversNear(ctx context.Context, point Point, radiusKm float64, count int) ([]DriverLocation, error) {
	if count <= 0 {
		count = 100
	}
	// Oversample so freshness filtering can still fill the caller's limit when
	// some GEO members are already stale between sweeps.
	fetchCount := count * 3
	if fetchCount < count {
		fetchCount = count
	}
	locations, err := s.redis.GeoRadius(ctx, driverLocationsKey, point.Lng, point.Lat, &redis.GeoRadiusQuery{
		Radius:    radiusKm,
		Unit:      "km",
		Sort:      "ASC",
		Count:     fetchCount,
		WithCoord: true,
	}).Result()
	if err != nil {
		return nil, err
	}
	if len(locations) == 0 {
		return []DriverLocation{}, nil
	}

	names := make([]string, len(locations))
	for i, loc := range locations {
		names[i] = loc.Name
	}
	scores, err := s.redis.ZMScore(ctx, driverSeenKey, names...).Result()
	if err != nil {
		return nil, err
	}
	cutoff := float64(time.Now().Add(-s.maxAge).UnixMilli())

	out := make([]DriverLocation, 0, count)
	for i, loc := range locations {
		// Missing members score 0, so they fail the cutoff too.
		if i >= len(scores) || scores[i] < cutoff {
			continue
		}
		out = append(out, DriverLocation{
			DriverID: loc.Name,
			Lat:      loc.Latitude,
			Lng:      loc.Longitude,
		})
		if len(out) >= count {
			break
		}
	}
	return s.attachMeta(ctx, out)
}

func (s *Store) loadMeta(ctx context.Context, driverID string) (*DriverLocation, error) {
	raw, err := s.redis.HGet(ctx, driverMetaKey, driverID).Result()
	if err == redis.Nil || raw == "" {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var loc DriverLocation
	if err := json.Unmarshal([]byte(raw), &loc); err != nil {
		return nil, err
	}
	loc.DriverID = driverID
	return &loc, nil
}

func (s *Store) attachMeta(ctx context.Context, locations []DriverLocation) ([]DriverLocation, error) {
	if len(locations) == 0 {
		return locations, nil
	}
	ids := make([]string, len(locations))
	for i, loc := range locations {
		ids[i] = loc.DriverID
	}
	vals, err := s.redis.HMGet(ctx, driverMetaKey, ids...).Result()
	if err != nil {
		return locations, nil
	}
	for i, val := range vals {
		raw, ok := val.(string)
		if !ok || raw == "" {
			continue
		}
		var meta DriverLocation
		if json.Unmarshal([]byte(raw), &meta) != nil {
			continue
		}
		locations[i].Heading = meta.Heading
		locations[i].Speed = meta.Speed
		locations[i].Accuracy = meta.Accuracy
		locations[i].TimestampMs = meta.TimestampMs
	}
	return locations, nil
}

// pointIndexRange is the lowest and highest route-point index of a trip's
// members found near a query point. Member names are "tripId:pointIndex".
type pointIndexRange struct {
	min, max int
}

func (s *Store) tripsNear(ctx context.Context, point Point, radiusKm float64) (map[string]pointIndexRange, error) {
	locations, err := s.redis.GeoRadius(ctx, routePointsKey, point.Lng, point.Lat, &redis.GeoRadiusQuery{
		Radius: radiusKm,
		Unit:   "km",
		Sort:   "ASC",
		Count:  maxRoutePointsPerSearch,
	}).Result()
	if err != nil {
		return nil, err
	}

	trips := make(map[string]pointIndexRange)
	for _, loc := range locations {
		sep := strings.LastIndex(loc.Name, ":")
		if sep <= 0 {
			continue
		}
		idx, err := strconv.Atoi(loc.Name[sep+1:])
		if err != nil {
			continue
		}
		tripID := loc.Name[:sep]
		r, ok := trips[tripID]
		if !ok {
			trips[tripID] = pointIndexRange{min: idx, max: idx}
			continue
		}
		if idx < r.min {
			r.min = idx
		}
		if idx > r.max {
			r.max = idx
		}
		trips[tripID] = r
	}
	return trips, nil
}
