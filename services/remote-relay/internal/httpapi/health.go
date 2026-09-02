package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// Pinger defines an interface for components that can be health-checked (e.g., database).
type Pinger interface {
	PingContext(ctx context.Context) error
}

type healthResponse struct {
	Status  string `json:"status"`
	Service string `json:"service"`
	Time    string `json:"time"`
}

type readyResponse struct {
	Status   string `json:"status"`
	Service  string `json:"service"`
	Database string `json:"database,omitempty"`
	Error    string `json:"error,omitempty"`
	Time     string `json:"time"`
}

// HealthzHandler returns 200 OK as long as the process is alive.
// It does not probe external dependencies to avoid cascading failure loops in liveness probes.
func HealthzHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}

		resp := healthResponse{
			Status:  "ok",
			Service: "freebuddy-remote-relay",
			Time:    time.Now().UTC().Format(time.RFC3339),
		}

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(resp)
	}
}

// ReadyzHandler verifies that the service is ready to accept traffic, including database connectivity.
func ReadyzHandler(db Pinger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")

		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()

		if db == nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(readyResponse{
				Status:  "not_ready",
				Service: "freebuddy-remote-relay",
				Error:   "database handle not initialized",
				Time:    time.Now().UTC().Format(time.RFC3339),
			})
			return
		}

		if err := db.PingContext(ctx); err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(readyResponse{
				Status:  "not_ready",
				Service: "freebuddy-remote-relay",
				Error:   "database unavailable",
				Time:    time.Now().UTC().Format(time.RFC3339),
			})
			return
		}

		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(readyResponse{
			Status:   "ready",
			Service:  "freebuddy-remote-relay",
			Database: "ok",
			Time:     time.Now().UTC().Format(time.RFC3339),
		})
	}
}
