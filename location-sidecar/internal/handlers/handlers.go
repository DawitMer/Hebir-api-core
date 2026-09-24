package handlers

import (
	"encoding/json"
	"log"
	"math"
	"net/http"
	"strconv"

	"hebir/location-svc/internal/demand"
	"hebir/location-svc/internal/geo"
)

type Handlers struct {
	Store  *geo.Store
	Demand *demand.Tracker
}

func New(store *geo.Store, tracker *demand.Tracker) *Handlers {
	return &Handlers{Store: store, Demand: tracker}
}

// IndexTrip handles POST /trips/index, called by api-core's matching
// module whenever a trip is published or amended.
func (h *Handlers) IndexTrip(w http.ResponseWriter, r *http.Request) {
	var trip geo.Trip
	if err := json.NewDecoder(r.Body).Decode(&trip); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if trip.ID == "" {
		http.Error(w, "trip id is required", http.StatusBadRequest)
		return
	}
	// Validate the same points the store will index (falls back to
	// start/destination when no route path is provided).
	points := trip.RoutePath
	if len(points) == 0 {
		points = []geo.Point{trip.StartPoint, trip.Destination}
	}
	for _, p := range points {
		if !geo.ValidPoint(p) {
			http.Error(w, geo.ErrInvalidPoint.Error(), http.StatusBadRequest)
			return
		}
	}

	if err := h.Store.IndexTrip(r.Context(), trip); err != nil {
		log.Printf("IndexTrip failed for %s: %v", trip.ID, err)
		http.Error(w, "failed to index trip", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// RemoveTrip handles POST /trips/remove so departed trips leave the corridor
// index instead of matching forever.
func (h *Handlers) RemoveTrip(w http.ResponseWriter, r *http.Request) {
	var req struct {
		TripID string `json:"tripId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.TripID == "" {
		http.Error(w, "tripId is required", http.StatusBadRequest)
		return
	}
	if err := h.Store.RemoveTrip(r.Context(), req.TripID); err != nil {
		log.Printf("RemoveTrip failed for %s: %v", req.TripID, err)
		http.Error(w, "failed to remove trip", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type driverLocationRequest struct {
	DriverID string    `json:"driverId"`
	Location geo.Point `json:"location"`
	Heading  *float64  `json:"heading"`
	Speed    *float64  `json:"speed"`
	Accuracy *float64  `json:"accuracy"`
	// Available=true → online idle supply. false → on_trip/reserved (busy).
	// Omitted/nil defaults to available for backward-compatible GPS pings.
	Available *bool  `json:"available"`
	ZoneID    string `json:"zoneId"`
}

// UpdateDriverLocation handles POST /drivers/location — the GPS ping
// ingestion point. Also feeds the demand tracker so the driver's zone
// registers as having supply available.
func (h *Handlers) UpdateDriverLocation(w http.ResponseWriter, r *http.Request) {
	var req driverLocationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.DriverID == "" {
		http.Error(w, "driverId is required", http.StatusBadRequest)
		return
	}
	if !geo.ValidPoint(req.Location) {
		http.Error(w, geo.ErrInvalidPoint.Error(), http.StatusBadRequest)
		return
	}

	result, err := h.Store.UpdateDriverLocation(r.Context(), req.DriverID, geo.Ping{
		Point:    req.Location,
		Heading:  sanitizeHeading(req.Heading),
		Speed:    sanitizeNonNeg(req.Speed),
		Accuracy: sanitizeNonNeg(req.Accuracy),
	})
	if err != nil {
		log.Printf("UpdateDriverLocation failed for %s: %v", req.DriverID, err)
		http.Error(w, "failed to update location", http.StatusInternalServerError)
		return
	}

	if result.Accepted {
		zoneID := req.ZoneID
		if zoneID == "" {
			zoneID = zoneIDFor(req.Location)
		}
		available := true
		if req.Available != nil {
			available = *req.Available
		}
		var err error
		if available {
			err = h.Demand.RecordDriverAvailable(
				r.Context(), zoneID, req.DriverID, req.Location.Lat, req.Location.Lng,
			)
		} else {
			err = h.Demand.RecordDriverBusy(
				r.Context(), zoneID, req.DriverID, req.Location.Lat, req.Location.Lng,
			)
		}
		if err != nil {
			log.Printf("demand driver update failed: %v", err)
		}
	}

	writeJSON(w, result)
}

// GetDriverPoint handles GET /drivers/point/{driverId} so a rider can fetch
// the assigned car without scanning the nearby fleet.
func (h *Handlers) GetDriverPoint(w http.ResponseWriter, r *http.Request) {
	driverID := r.PathValue("driverId")
	if driverID == "" {
		http.Error(w, "driverId is required", http.StatusBadRequest)
		return
	}
	loc, err := h.Store.GetDriver(r.Context(), driverID)
	if err != nil {
		log.Printf("GetDriver failed for %s: %v", driverID, err)
		http.Error(w, "failed to read location", http.StatusInternalServerError)
		return
	}
	if loc == nil {
		http.Error(w, "driver not in live index", http.StatusNotFound)
		return
	}
	writeJSON(w, loc)
}

// RecordRiderDemand handles POST /demand/request — on-demand ride create only.
// Requires riderId so refreshes by the same rider cannot inflate surge.
func (h *Handlers) RecordRiderDemand(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Location geo.Point `json:"location"`
		RiderID  string    `json:"riderId"`
		ZoneID   string    `json:"zoneId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if !geo.ValidPoint(req.Location) {
		http.Error(w, geo.ErrInvalidPoint.Error(), http.StatusBadRequest)
		return
	}
	if req.RiderID == "" {
		http.Error(w, "riderId is required", http.StatusBadRequest)
		return
	}
	zoneID := req.ZoneID
	if zoneID == "" {
		zoneID = zoneIDFor(req.Location)
	}
	if err := h.Demand.RecordRiderActive(
		r.Context(), zoneID, req.RiderID, req.Location.Lat, req.Location.Lng,
	); err != nil {
		log.Printf("RecordRiderActive failed: %v", err)
		http.Error(w, "failed to record demand", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ReleaseRiderDemand handles POST /demand/release — cancel / match / complete.
func (h *Handlers) ReleaseRiderDemand(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RiderID string `json:"riderId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.RiderID == "" {
		http.Error(w, "riderId is required", http.StatusBadRequest)
		return
	}
	if err := h.Demand.ReleaseRider(r.Context(), req.RiderID); err != nil {
		log.Printf("ReleaseRider failed: %v", err)
		http.Error(w, "failed to release demand", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func sanitizeHeading(v *float64) *float64 {
	if v == nil || math.IsNaN(*v) || *v < 0 || *v > 360 {
		return nil
	}
	return v
}

func sanitizeNonNeg(v *float64) *float64 {
	if v == nil || math.IsNaN(*v) || *v < 0 {
		return nil
	}
	return v
}

// RemoveDriverLocation handles POST /drivers/offline so a driver who goes
// offline leaves the live index immediately instead of waiting for the
// staleness sweep.
func (h *Handlers) RemoveDriverLocation(w http.ResponseWriter, r *http.Request) {
	var req struct {
		DriverID string `json:"driverId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.DriverID == "" {
		http.Error(w, "driverId is required", http.StatusBadRequest)
		return
	}
	if err := h.Store.RemoveDriver(r.Context(), req.DriverID); err != nil {
		log.Printf("RemoveDriver failed for %s: %v", req.DriverID, err)
		http.Error(w, "failed to remove location", http.StatusInternalServerError)
		return
	}
	// Also drop the driver from the demand supply sets so an offline driver
	// stops suppressing surge until the window expires.
	if err := h.Demand.RemoveDriver(r.Context(), req.DriverID); err != nil {
		log.Printf("demand RemoveDriver failed for %s: %v", req.DriverID, err)
	}
	w.WriteHeader(http.StatusNoContent)
}

type corridorSearchRequest struct {
	Pickup          geo.Point `json:"pickup"`
	Dropoff         geo.Point `json:"dropoff"`
	CorridorWidthKm float64   `json:"corridorWidthKm"`
}

type corridorSearchResponse struct {
	TripIDs []string `json:"tripIds"`
}

// CorridorSearch handles POST /corridor-search — Layer 2 of the matching
// pipeline (blueprint 6.7). Does NOT record surge demand: browse/match polls
// must not fabricate marketplace shortage.
func (h *Handlers) CorridorSearch(w http.ResponseWriter, r *http.Request) {
	var req corridorSearchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if !geo.ValidPoint(req.Pickup) || !geo.ValidPoint(req.Dropoff) {
		http.Error(w, geo.ErrInvalidPoint.Error(), http.StatusBadRequest)
		return
	}
	req.CorridorWidthKm = geo.ClampRadiusKm(req.CorridorWidthKm, 2)

	tripIDs, err := h.Store.CorridorSearch(r.Context(), req.Pickup, req.Dropoff, req.CorridorWidthKm)
	if err != nil {
		log.Printf("CorridorSearch failed: %v", err)
		http.Error(w, "corridor search failed", http.StatusInternalServerError)
		return
	}

	writeJSON(w, corridorSearchResponse{TripIDs: tripIDs})
}

// ZoneDemand handles GET /zones/{zoneId}/demand, used by api-core's fare
// module to compute the surge multiplier from live hex counts.
func (h *Handlers) ZoneDemand(w http.ResponseWriter, r *http.Request, zoneID string) {
	snap, err := h.Demand.ZoneSnapshot(r.Context(), zoneID)
	if err != nil {
		log.Printf("ZoneSnapshot failed for zone %s: %v", zoneID, err)
		http.Error(w, "failed to compute demand", http.StatusInternalServerError)
		return
	}
	writeJSON(w, snap)
}

type demandGridResponse struct {
	Cells []demand.Cell `json:"cells"`
}

// DemandGrid handles GET /demand/grid?minLat=&minLng=&maxLat=&maxLng=
// for Uber/Lyft-style busy-area heat overlays on Flutter maps.
func (h *Handlers) DemandGrid(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	minLat, err1 := strconv.ParseFloat(q.Get("minLat"), 64)
	minLng, err2 := strconv.ParseFloat(q.Get("minLng"), 64)
	maxLat, err3 := strconv.ParseFloat(q.Get("maxLat"), 64)
	maxLng, err4 := strconv.ParseFloat(q.Get("maxLng"), 64)
	if err1 != nil || err2 != nil || err3 != nil || err4 != nil {
		http.Error(w, "minLat,minLng,maxLat,maxLng required", http.StatusBadRequest)
		return
	}

	cells, err := h.Demand.Grid(r.Context(), minLat, minLng, maxLat, maxLng)
	if err != nil {
		log.Printf("DemandGrid failed: %v", err)
		http.Error(w, "failed to load demand grid", http.StatusInternalServerError)
		return
	}
	if cells == nil {
		cells = []demand.Cell{}
	}
	writeJSON(w, demandGridResponse{Cells: cells})
}

// NearbyDrivers handles POST /drivers/nearby — expanding-radius candidate
// search for on-demand dispatch (api-core rides module).
func (h *Handlers) NearbyDrivers(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Pickup   geo.Point `json:"pickup"`
		RadiusKm float64   `json:"radiusKm"`
		Limit    int       `json:"limit"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if !geo.ValidPoint(req.Pickup) {
		http.Error(w, geo.ErrInvalidPoint.Error(), http.StatusBadRequest)
		return
	}
	req.RadiusKm = geo.ClampRadiusKm(req.RadiusKm, 1.5)
	ids, err := h.Store.NearestDrivers(r.Context(), req.Pickup, req.RadiusKm, req.Limit)
	if err != nil {
		log.Printf("NearbyDrivers failed: %v", err)
		http.Error(w, "nearby search failed", http.StatusInternalServerError)
		return
	}
	if ids == nil {
		ids = []string{}
	}
	writeJSON(w, map[string]any{"driverIds": ids})
}

// NearbyDriversInZones handles POST /drivers/nearby-zones — H3 hex-ring
// supply lookup (same demand:supply:* sets as map heat). Api-core sends
// zoneIds from h3-js gridDisk; optional pickup+radiusKm ranks by distance.
func (h *Handlers) NearbyDriversInZones(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ZoneIDs  []string  `json:"zoneIds"`
		Pickup   geo.Point `json:"pickup"`
		RadiusKm float64   `json:"radiusKm"`
		Limit    int       `json:"limit"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if len(req.ZoneIDs) == 0 {
		writeJSON(w, map[string]any{"driverIds": []string{}})
		return
	}
	if len(req.ZoneIDs) > 200 {
		req.ZoneIDs = req.ZoneIDs[:200]
	}
	ids, err := h.Demand.FreshSupplyDrivers(r.Context(), req.ZoneIDs)
	if err != nil {
		log.Printf("NearbyDriversInZones failed: %v", err)
		http.Error(w, "hex nearby search failed", http.StatusInternalServerError)
		return
	}
	if ids == nil {
		ids = []string{}
	}
	// When pickup is valid, prefer GEO-ranked order among hex members so
	// dispatch still sorts by approximate road distance (haversine proxy).
	if geo.ValidPoint(req.Pickup) && len(ids) > 0 {
		req.RadiusKm = geo.ClampRadiusKm(req.RadiusKm, 1.5)
		ranked, rankErr := h.Store.NearestDrivers(r.Context(), req.Pickup, req.RadiusKm, max(req.Limit, 40))
		if rankErr == nil && len(ranked) > 0 {
			inHex := make(map[string]struct{}, len(ids))
			for _, id := range ids {
				inHex[id] = struct{}{}
			}
			ordered := make([]string, 0, len(ids))
			seen := make(map[string]struct{}, len(ids))
			for _, id := range ranked {
				if _, ok := inHex[id]; !ok {
					continue
				}
				if _, ok := seen[id]; ok {
					continue
				}
				seen[id] = struct{}{}
				ordered = append(ordered, id)
			}
			for _, id := range ids {
				if _, ok := seen[id]; ok {
					continue
				}
				ordered = append(ordered, id)
			}
			ids = ordered
		}
	}
	if req.Limit > 0 && len(ids) > req.Limit {
		ids = ids[:req.Limit]
	}
	writeJSON(w, map[string]any{"driverIds": ids})
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// ListDriverLocations handles GET /drivers/locations?lat=&lng=&radiusKm=&limit=
// Used by the Operations portal fleet map (live Redis GEO positions).
func (h *Handlers) ListDriverLocations(w http.ResponseWriter, r *http.Request) {
	lat, latErr := strconv.ParseFloat(r.URL.Query().Get("lat"), 64)
	lng, lngErr := strconv.ParseFloat(r.URL.Query().Get("lng"), 64)
	if latErr != nil || lngErr != nil {
		http.Error(w, "lat and lng query params are required", http.StatusBadRequest)
		return
	}
	radiusKm, _ := strconv.ParseFloat(r.URL.Query().Get("radiusKm"), 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	center := geo.Point{Lat: lat, Lng: lng}
	if !geo.ValidPoint(center) {
		http.Error(w, geo.ErrInvalidPoint.Error(), http.StatusBadRequest)
		return
	}
	radiusKm = geo.ClampRadiusKm(radiusKm, 25)
	if limit <= 0 {
		limit = 250
	}
	if limit > 500 {
		limit = 500 // hard cap — Ops maps must cluster beyond this
	}
	locations, err := h.Store.DriversNear(r.Context(), center, radiusKm, limit)
	if err != nil {
		log.Printf("ListDriverLocations failed: %v", err)
		http.Error(w, "location listing failed", http.StatusInternalServerError)
		return
	}
	if locations == nil {
		locations = []geo.DriverLocation{}
	}
	writeJSON(w, map[string]any{"drivers": locations, "limit": limit})
}

// zoneIDFor is a legacy square-grid fallback. Callers should send the Uber H3
// zoneId from api-core (h3-js, resolution demand.H3Resolution).
func zoneIDFor(p geo.Point) string {
	return demand.ZoneIDFor(p.Lat, p.Lng)
}

func writeJSON(w http.ResponseWriter, payload any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("writeJSON failed: %v", err)
	}
}
