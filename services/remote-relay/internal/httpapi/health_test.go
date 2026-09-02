package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/freebuddy/freebuddy/services/remote-relay/internal/config"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/store"
)

type mockPinger struct {
	err error
}

func (m *mockPinger) PingContext(ctx context.Context) error {
	return m.err
}

func TestHealthzHandler(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()

	handler := HealthzHandler()
	handler.ServeHTTP(rec, req)

	res := rec.Result()
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200, got %d", res.StatusCode)
	}

	if ct := res.Header.Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("expected Content-Type application/json; charset=utf-8, got %s", ct)
	}

	var body healthResponse
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if body.Status != "ok" {
		t.Errorf("expected status ok, got %s", body.Status)
	}
	if body.Service != "freebuddy-remote-relay" {
		t.Errorf("expected service freebuddy-remote-relay, got %s", body.Service)
	}
	if body.Time == "" {
		t.Errorf("expected non-empty timestamp")
	}
}

func TestHealthzHandler_MethodNotAllowed(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/healthz", nil)
	rec := httptest.NewRecorder()

	handler := HealthzHandler()
	handler.ServeHTTP(rec, req)

	res := rec.Result()
	defer res.Body.Close()

	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("expected status 405, got %d", res.StatusCode)
	}
}

func TestReadyzHandler_Healthy(t *testing.T) {
	mock := &mockPinger{err: nil}
	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rec := httptest.NewRecorder()

	handler := ReadyzHandler(mock)
	handler.ServeHTTP(rec, req)

	res := rec.Result()
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200, got %d", res.StatusCode)
	}

	var body readyResponse
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if body.Status != "ready" {
		t.Errorf("expected status ready, got %s", body.Status)
	}
	if body.Database != "ok" {
		t.Errorf("expected database ok, got %s", body.Database)
	}
}

func TestReadyzHandler_Unhealthy(t *testing.T) {
	mock := &mockPinger{err: errors.New("db connection refused")}
	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rec := httptest.NewRecorder()

	handler := ReadyzHandler(mock)
	handler.ServeHTTP(rec, req)

	res := rec.Result()
	defer res.Body.Close()

	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("expected status 503, got %d", res.StatusCode)
	}

	var body readyResponse
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if body.Status != "not_ready" {
		t.Errorf("expected status not_ready, got %s", body.Status)
	}
	if body.Error == "" {
		t.Errorf("expected non-empty error message")
	}
}

func TestReadyzHandler_NilDB(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rec := httptest.NewRecorder()

	handler := ReadyzHandler(nil)
	handler.ServeHTTP(rec, req)

	res := rec.Result()
	defer res.Body.Close()

	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("expected status 503, got %d", res.StatusCode)
	}
}

func TestServer_Integration(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.DevAuthMode = true

	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}
	defer db.Close()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServer(cfg, db, logger)

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// Test GET /healthz
	resp, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatalf("healthz request failed: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200 from /healthz, got %d", resp.StatusCode)
	}
	if val := resp.Header.Get("X-Content-Type-Options"); val != "nosniff" {
		t.Errorf("expected X-Content-Type-Options nosniff, got %s", val)
	}
	resp.Body.Close()

	// Test GET /readyz
	resp, err = http.Get(ts.URL + "/readyz")
	if err != nil {
		t.Fatalf("readyz request failed: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200 from /readyz, got %d", resp.StatusCode)
	}
	resp.Body.Close()
}
