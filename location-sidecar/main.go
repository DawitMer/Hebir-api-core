package main

import (
	"context"
	"crypto/subtle"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"hebir/location-svc/internal/demand"
	"hebir/location-svc/internal/geo"
	"hebir/location-svc/internal/handlers"
	"hebir/location-svc/internal/ratelimit"
	"hebir/location-svc/internal/secrets"
)

func main() {
	if err := secrets.LoadFromEnvBackend(); err != nil {
		log.Fatalf("secrets: %v", err)
	}

	requireAuth := os.Getenv("REQUIRE_AUTH") == "true" || os.Getenv("NODE_ENV") == "production"
	token := os.Getenv("LOCATION_SVC_TOKEN")
	if requireAuth && token == "" {
		log.Fatal("LOCATION_SVC_TOKEN is required when REQUIRE_AUTH=true or NODE_ENV=production")
	}

	port := getEnv("PORT", "8090")
	client := newRedisClient()

	maxAge := durationFromEnv("DRIVER_LOCATION_TTL_SECONDS", 5*time.Minute)
	store := geo.NewStore(client, maxAge)
	tracker := demand.NewTracker(client)
	h := handlers.New(store, tracker)

	limitN := ratelimit.LimitFromEnv()
	gpsLimit := ratelimit.Middleware(client, limitN, time.Minute)
	writeLimit := ratelimit.WriteMiddleware(client, limitN, time.Minute)

	// Bounded request bodies: json.NewDecoder on an unbounded r.Body lets one
	// POST hold arbitrary memory.
	limit := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
			next(w, r)
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /trips/index", limit(writeLimit(h.IndexTrip)))
	mux.HandleFunc("POST /trips/remove", limit(writeLimit(h.RemoveTrip)))
	mux.HandleFunc("POST /corridor-search", limit(h.CorridorSearch))
	mux.HandleFunc("POST /drivers/location", limit(gpsLimit(h.UpdateDriverLocation)))
	mux.HandleFunc("POST /drivers/offline", limit(h.RemoveDriverLocation))
	mux.HandleFunc("POST /drivers/nearby", limit(writeLimit(h.NearbyDrivers)))
	mux.HandleFunc("GET /drivers/locations", h.ListDriverLocations)
	mux.HandleFunc("GET /drivers/point/{driverId}", h.GetDriverPoint)
	mux.HandleFunc("POST /demand/request", limit(writeLimit(h.RecordRiderDemand)))
	mux.HandleFunc("POST /demand/release", limit(writeLimit(h.ReleaseRiderDemand)))
	mux.HandleFunc("GET /demand/grid", h.DemandGrid)
	mux.HandleFunc("/zones/", func(w http.ResponseWriter, r *http.Request) {
		// Expects /zones/{zoneId}/demand
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) != 3 || parts[2] != "demand" || r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		h.ZoneDemand(w, r, parts[1])
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		if err := client.Ping(r.Context()).Err(); err != nil {
			http.Error(w, "redis unavailable", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go evictStaleDrivers(ctx, store, maxAge)

	log.Printf("location-svc listening on :%s", port)
	server := &http.Server{
		Addr:              ":" + port,
		Handler:           authMiddleware(mux, token),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	errc := make(chan error, 1)
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errc <- err
		}
	}()

	select {
	case err := <-errc:
		log.Fatal(err)
	case <-ctx.Done():
		log.Print("location-svc shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("graceful shutdown failed: %v", err)
		}
		_ = client.Close()
	}
}

// authMiddleware enforces LOCATION_SVC_TOKEN on all routes except liveness and
// readiness probes. Callers may send Authorization: Bearer <token> or
// X-Location-Token: <token>. When the env var is unset the service stays open
// for local demos (boot already fatals if auth is required).
func authMiddleware(next http.Handler, token string) http.Handler {
	if token == "" {
		return next
	}
	want := []byte(token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
			next.ServeHTTP(w, r)
			return
		}
		got := r.Header.Get("Authorization")
		if strings.HasPrefix(got, "Bearer ") {
			got = strings.TrimPrefix(got, "Bearer ")
		} else {
			got = r.Header.Get("X-Location-Token")
		}
		if subtle.ConstantTimeCompare([]byte(got), want) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// evictStaleDrivers drops drivers who stopped pinging. Without it the Redis GEO
// index only ever grows and a crashed app keeps its driver "nearby" forever.
func evictStaleDrivers(ctx context.Context, store *geo.Store, maxAge time.Duration) {
	interval := durationFromEnv("DRIVER_LOCATION_SWEEP_SECONDS", 30*time.Second)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			removed, err := store.EvictStaleDrivers(ctx, maxAge)
			if err != nil {
				log.Printf("stale driver eviction failed: %v", err)
				continue
			}
			if removed > 0 {
				log.Printf("evicted %d stale driver location(s) older than %s", removed, maxAge)
			}
		}
	}
}

func durationFromEnv(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
	}
	return fallback
}

func newRedisClient() *redis.Client {
	poolSize := 250
	if v := os.Getenv("REDIS_POOL_SIZE"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			poolSize = n
		}
	}
	minIdle := 25
	if v := os.Getenv("REDIS_MIN_IDLE"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			minIdle = n
		}
	}

	const dialTimeout = 3 * time.Second
	const readTimeout = 3 * time.Second
	const writeTimeout = 3 * time.Second

	// Prefer Upstash / managed Redis URL when present.
	if redisURL := os.Getenv("REDIS_URL"); redisURL != "" {
		opt, err := redis.ParseURL(redisURL)
		if err != nil {
			log.Fatalf("invalid REDIS_URL: %v", err)
		}
		opt.PoolSize = poolSize
		opt.MinIdleConns = minIdle
		opt.PoolTimeout = 5 * time.Second
		opt.DialTimeout = dialTimeout
		opt.ReadTimeout = readTimeout
		opt.WriteTimeout = writeTimeout
		log.Printf("redis via REDIS_URL pool=%d", poolSize)
		return redis.NewClient(opt)
	}

	redisAddr := getEnv("REDIS_ADDR", "localhost:16380")
	log.Printf("redis via REDIS_ADDR=%s pool=%d", redisAddr, poolSize)
	return redis.NewClient(&redis.Options{
		Addr:         redisAddr,
		PoolSize:     poolSize,
		MinIdleConns: minIdle,
		PoolTimeout:  5 * time.Second,
		DialTimeout:  dialTimeout,
		ReadTimeout:  readTimeout,
		WriteTimeout: writeTimeout,
	})
}

// maxRequestBodyBytes is generous for a route path payload, tiny for an attacker.
const maxRequestBodyBytes = 1 << 20 // 1 MiB

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
