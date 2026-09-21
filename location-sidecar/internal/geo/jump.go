package geo

import (
	"math"
	"time"
)

// Vehicle GPS is noisy (urban canyons, indoor starts). These bounds reject
// samples that cannot be a car in Addis without dropping a merely jittery ping.
const (
	// ~180 km/h — faster than any legal Addis hop; below airplane/teleport speeds.
	maxPlausibleSpeedMps = 50.0
	// Horizontal slack for a single cheap GNSS sample.
	gpsSlackM = 75.0
	// Fixes worse than this are not worth moving the marker for.
	maxAcceptableAccuracyM = 120.0
	// After a long gap (tunnel, app backgrounded) a large jump is a resume, not spoofing.
	teleportAfter = 90 * time.Second
)

// HaversineMeters is the great-circle distance between two WGS84 points.
// O(1) time / O(1) space — used as a cheap gate before any route work.
func HaversineMeters(a, b Point) float64 {
	const earthRadiusM = 6371000.0
	lat1 := a.Lat * math.Pi / 180
	lat2 := b.Lat * math.Pi / 180
	dLat := (b.Lat - a.Lat) * math.Pi / 180
	dLng := (b.Lng - a.Lng) * math.Pi / 180
	sinDLat := math.Sin(dLat / 2)
	sinDLng := math.Sin(dLng / 2)
	h := sinDLat*sinDLat + math.Cos(lat1)*math.Cos(lat2)*sinDLng*sinDLng
	return 2 * earthRadiusM * math.Asin(math.Min(1, math.Sqrt(h)))
}

// AcceptPing reports whether `next` may replace `prev` in the live index.
//
// Why not a full Kalman filter: at 3–12s pings a 1-state speed gate plus
// client interpolation already stops teleports. Kalman needs process-noise
// tuning per device and would still need this same hard cap for spoofed jumps.
func AcceptPing(prev *DriverLocation, next Point, accuracy *float64, now time.Time) (ok bool, reason string) {
	if prev == nil || prev.TimestampMs == 0 {
		return true, ""
	}
	if accuracy != nil && *accuracy > maxAcceptableAccuracyM {
		return false, "low_accuracy"
	}

	prevT := time.UnixMilli(prev.TimestampMs)
	dt := now.Sub(prevT)
	if dt > teleportAfter {
		return true, ""
	}
	if dt < 0 {
		return false, "stale_timestamp"
	}

	dist := HaversineMeters(Point{Lat: prev.Lat, Lng: prev.Lng}, next)
	slack := gpsSlackM
	if accuracy != nil && *accuracy > 0 {
		slack += *accuracy
	}
	dtSec := dt.Seconds()
	if dtSec < 0.25 {
		dtSec = 0.25
	}
	maxDist := slack + maxPlausibleSpeedMps*dtSec
	if dist > maxDist {
		return false, "implausible_jump"
	}
	return true, ""
}
