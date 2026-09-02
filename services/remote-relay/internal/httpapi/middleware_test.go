package httpapi

import (
	"bytes"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRecovery_NoSecretLeakage(t *testing.T) {
	sensitiveToken := "ADMIN_SECRET_TOKEN_DO_NOT_LEAK_987654321"
	sensitivePayload := "Sensitive business message content with token"

	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))

	panickingHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic(fmt.Sprintf("%s: %s", sensitiveToken, sensitivePayload))
	})

	handler := Recovery(logger)(panickingHandler)

	req := httptest.NewRequest(http.MethodPost, "/v1/test/panic-action", nil)
	rec := httptest.NewRecorder()

	// Should not crash the process
	handler.ServeHTTP(rec, req)

	res := rec.Result()
	defer res.Body.Close()

	if res.StatusCode != http.StatusInternalServerError {
		t.Fatalf("expected status 500, got %d", res.StatusCode)
	}

	logOutput := buf.String()

	// Verify error log was written
	if !strings.Contains(logOutput, "panic recovered in http handler") {
		t.Errorf("expected log message 'panic recovered in http handler', got: %s", logOutput)
	}

	// Verify path was safely logged
	if !strings.Contains(logOutput, "/v1/test/panic-action") {
		t.Errorf("expected path '/v1/test/panic-action' in log, got: %s", logOutput)
	}

	// Verify sensitive panic value / token is NOT logged
	if strings.Contains(logOutput, sensitiveToken) {
		t.Errorf("SECURITY LEAK: sensitive token was found in log output: %s", logOutput)
	}
	if strings.Contains(logOutput, sensitivePayload) {
		t.Errorf("SECURITY LEAK: sensitive payload was found in log output: %s", logOutput)
	}

	// Verify stack trace is NOT logged
	stackTraceMarkers := []string{
		"goroutine ",
		"runtime/panic.go",
		"runtime.gopanic",
		"debug.Stack",
		"middleware_test.go",
	}
	for _, marker := range stackTraceMarkers {
		if strings.Contains(logOutput, marker) {
			t.Errorf("SECURITY LEAK: stack trace marker %q found in log output: %s", marker, logOutput)
		}
	}
}

func TestRecovery_NormalHandler(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))

	normalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("success"))
	})

	handler := Recovery(logger)(normalHandler)

	req := httptest.NewRequest(http.MethodGet, "/v1/normal", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	res := rec.Result()
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200, got %d", res.StatusCode)
	}

	if buf.Len() != 0 {
		t.Errorf("expected no error logs for normal request, got: %s", buf.String())
	}
}

func TestRequestLogger(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))

	innerHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	})

	handler := RequestLogger(logger)(innerHandler)

	req := httptest.NewRequest(http.MethodPost, "/v1/test-log", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	logOutput := buf.String()
	if !strings.Contains(logOutput, "http request") {
		t.Errorf("expected 'http request' log, got: %s", logOutput)
	}
	if !strings.Contains(logOutput, "/v1/test-log") {
		t.Errorf("expected path in log, got: %s", logOutput)
	}
	if !strings.Contains(logOutput, "\"status\":202") {
		t.Errorf("expected status 202 in log, got: %s", logOutput)
	}
}

func TestSecurityHeaders(t *testing.T) {
	innerHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	handler := SecurityHeaders(innerHandler)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	res := rec.Result()
	defer res.Body.Close()

	if val := res.Header.Get("X-Content-Type-Options"); val != "nosniff" {
		t.Errorf("expected X-Content-Type-Options: nosniff, got %s", val)
	}
	if val := res.Header.Get("X-Frame-Options"); val != "DENY" {
		t.Errorf("expected X-Frame-Options: DENY, got %s", val)
	}
	if val := res.Header.Get("Referrer-Policy"); val != "no-referrer" {
		t.Errorf("expected Referrer-Policy: no-referrer, got %s", val)
	}
}
