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
		if err := h.Demand.RecordDriverAvailable(
			r.Context(),
			zoneIDFor(req.Location),
			req.DriverID,
		); err != nil {
			log.Printf("RecordDriverAvailable failed: %v", err)
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

// RecordRiderDemand handles POST /demand/request — on-demand ride create
// (shared trips already record demand inside CorridorSearch).
func (h *Handlers) RecordRiderDemand(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Location geo.Point `json:"location"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if !geo.ValidPoint(req.Location) {
		http.Error(w, geo.ErrInvalidPoint.Error(), http.StatusBadRequest)
		return
	}
	if err := h.Demand.RecordRiderRequest(r.Context(), zoneIDFor(req.Location)); err != nil {
		log.Printf("RecordRiderRequest failed: %v", err)
		http.Error(w, "failed to record demand", http.StatusInternalServerError)
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
// pipeline (blueprint 6.7). Also records a demand signal for the pickup
// zone so the fare module can compute surge.
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

	if err := h.Demand.RecordRiderRequest(r.Context(), zoneIDFor(req.Pickup)); err != nil {
		log.Printf("RecordRiderRequest failed: %v", err)
	}

	writeJSON(w, corridorSearchResponse{TripIDs: tripIDs})
}

type demandResponse struct {
	DemandRatio float64 `json:"demandRatio"`
}

// ZoneDemand handles GET /zones/{zoneId}/demand, used by api-core's fare
// module to compute the surge multiplier.
func (h *Handlers) ZoneDemand(w http.ResponseWriter, r *http.Request, zoneID string) {
	ratio, err := h.Demand.DemandRatio(r.Context(), zoneID)
	if err != nil {
		log.Printf("DemandRatio failed for zone %s: %v", zoneID, err)
		http.Error(w, "failed to compute demand", http.StatusInternalServerError)
		return
	}
	writeJSON(w, demandResponse{DemandRatio: ratio})
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

// zoneIDFor buckets a point into a coarse grid cell. Good enough as a
// zone identifier for demand tracking without a dedicated zones table.
// Floor (not truncation) so this agrees with api-core's zoneIdFor for
// negative coordinates — the two must produce identical ids or surge is
// looked up from a zone nobody is recording demand into.
func zoneIDFor(p geo.Point) string {
	const cellSizeDegrees = demand.CellSizeDegrees // roughly 2km at the equator
	latCell := int(math.Floor(p.Lat / cellSizeDegrees))
	lngCell := int(math.Floor(p.Lng / cellSizeDegrees))
	return "z:" + strconv.Itoa(latCell) + ":" + strconv.Itoa(lngCell)
}

func writeJSON(w http.ResponseWriter, payload any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("writeJSON failed: %v", err)
	}
}
