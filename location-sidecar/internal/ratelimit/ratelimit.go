package ratelimit

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// INCR + EXPIRE must be atomic: a process crash between them leaves a key
// with no TTL that rate-limits forever.
var incrExpireScript = redis.NewScript(`
local n = redis.call('INCR', KEYS[1])
if n == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return n
`)

// Middleware rate-limits GPS pings per driverId (fallback: client IP).
func Middleware(rdb *redis.Client, limit int, window time.Duration) func(http.HandlerFunc) http.HandlerFunc {
	return keyed(rdb, "rl:gps:svc:", limit, window, true)
}

// WriteMiddleware rate-limits write endpoints by client IP.
func WriteMiddleware(rdb *redis.Client, limit int, window time.Duration) func(http.HandlerFunc) http.HandlerFunc {
	return keyed(rdb, "rl:write:svc:", limit, window, false)
}

func keyed(rdb *redis.Client, prefix string, limit int, window time.Duration, preferDriverID bool) func(http.HandlerFunc) http.HandlerFunc {
	if os.Getenv("RATE_LIMIT_ENABLED") == "false" {
		return func(next http.HandlerFunc) http.HandlerFunc { return next }
	}
	if limit <= 0 {
		limit = 20
	}
	if window <= 0 {
		window = time.Minute
	}

	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			identity := clientIP(r)
			if preferDriverID {
				body, err := io.ReadAll(r.Body)
				if err == nil && len(body) > 0 {
					var payload struct {
						DriverID string `json:"driverId"`
					}
					if json.Unmarshal(body, &payload) == nil && payload.DriverID != "" {
						identity = payload.DriverID
					}
					r.Body = io.NopCloser(bytes.NewReader(body))
				} else {
					r.Body = io.NopCloser(bytes.NewReader(body))
				}
			}

			allowed, retryAfter, err := allow(r.Context(), rdb, prefix+identity, limit, window)
			if err != nil {
				log.Printf("rate-limit redis error: %v", err)
				next(w, r)
				return
			}
			w.Header().Set("X-RateLimit-Limit", strconv.Itoa(limit))
			if !allowed {
				w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
				http.Error(w, `{"message":"Too many requests"}`, http.StatusTooManyRequests)
				return
			}
			next(w, r)
		}
	}
}

func allow(ctx context.Context, rdb *redis.Client, key string, limit int, window time.Duration) (bool, int, error) {
	secs := int(window.Seconds())
	if secs < 1 {
		secs = 1
	}
	count, err := incrExpireScript.Run(ctx, rdb, []string{key}, secs).Int64()
	if err != nil {
		return true, 0, err
	}
	if count > int64(limit) {
		ttl, err := rdb.TTL(ctx, key).Result()
		retry := secs
		if err == nil && ttl > 0 {
			retry = int(ttl.Seconds())
		}
		return false, retry, nil
	}
	return true, 0, nil
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := bytes.IndexByte([]byte(xff), ','); i >= 0 {
			return string(bytes.TrimSpace([]byte(xff[:i])))
		}
		return xff
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// LimitFromEnv reads RATE_LIMIT_GPS (default 20).
func LimitFromEnv() int {
	if v := os.Getenv("RATE_LIMIT_GPS"); v != "" {
		n, err := strconv.Atoi(v)
		if err == nil && n > 0 {
			return n
		}
	}
	return 20
}
