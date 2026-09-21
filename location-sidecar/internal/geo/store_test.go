package geo

import (
	"testing"
	"time"
)

func TestValidPoint(t *testing.T) {
	ok := Point{Lat: 8.9878, Lng: 38.791}
	if !ValidPoint(ok) {
		t.Fatalf("expected Addis pin to be valid")
	}
	if ValidPoint(Point{Lat: 95, Lng: 0}) {
		t.Fatalf("expected out-of-range lat to be invalid")
	}
	if ValidPoint(Point{Lat: 0, Lng: 200}) {
		t.Fatalf("expected out-of-range lng to be invalid")
	}
}

func TestClampRadiusKm(t *testing.T) {
	if got := ClampRadiusKm(0, 5); got != 5 {
		t.Fatalf("fallback: got %v", got)
	}
	if got := ClampRadiusKm(500, 5); got != MaxRadiusKm {
		t.Fatalf("cap: got %v", got)
	}
	if got := ClampRadiusKm(12, 5); got != 12 {
		t.Fatalf("passthrough: got %v", got)
	}
}

func TestHaversineMetersBoleToMeskel(t *testing.T) {
	bole := Point{Lat: 8.9878, Lng: 38.791}
	// ~500 m west is still a city block, not a teleport.
	near := Point{Lat: 8.9878, Lng: 38.7865}
	d := HaversineMeters(bole, near)
	if d < 400 || d > 700 {
		t.Fatalf("expected ~500m, got %v", d)
	}
}

func TestAcceptPingRejectsTeleport(t *testing.T) {
	now := time.Now()
	prev := &DriverLocation{
		Lat:         8.9878,
		Lng:         38.791,
		TimestampMs: now.Add(-3 * time.Second).UnixMilli(),
	}
	// ~5 km in 3s is not a car.
	next := Point{Lat: 9.03, Lng: 38.75}
	ok, reason := AcceptPing(prev, next, nil, now)
	if ok {
		t.Fatalf("expected jump rejection, got accept")
	}
	if reason != "implausible_jump" {
		t.Fatalf("reason: %s", reason)
	}
}

func TestAcceptPingAllowsResumeAfterGap(t *testing.T) {
	now := time.Now()
	prev := &DriverLocation{
		Lat:         8.9878,
		Lng:         38.791,
		TimestampMs: now.Add(-3 * time.Minute).UnixMilli(),
	}
	next := Point{Lat: 9.03, Lng: 38.75}
	ok, _ := AcceptPing(prev, next, nil, now)
	if !ok {
		t.Fatalf("long gap should accept a new fix")
	}
}

func TestAcceptPingRejectsLowAccuracy(t *testing.T) {
	now := time.Now()
	prev := &DriverLocation{Lat: 8.9878, Lng: 38.791, TimestampMs: now.UnixMilli()}
	acc := 250.0
	ok, reason := AcceptPing(prev, Point{Lat: 8.988, Lng: 38.791}, &acc, now)
	if ok || reason != "low_accuracy" {
		t.Fatalf("got ok=%v reason=%s", ok, reason)
	}
}
