package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/freebuddy/freebuddy/services/remote-relay/internal/config"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/httpapi"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/protocol"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/store"
)

func TestRunSmoke_TLSWSSAndDataBoundary(t *testing.T) {
	adminToken := randomBase64URL(t, 32)
	hostToken := randomBase64URL(t, 32)
	payloadSentinel := "payload_" + randomBase64URL(t, 18)
	databasePath := filepath.Join(t.TempDir(), "relay.db")

	cfg := config.DefaultConfig()
	cfg.DevAuthMode = true
	cfg.DevAuthAdminToken = adminToken
	cfg.DevAuthHostToken = hostToken
	cfg.DevAuthHostID = "m2_smoke_host"
	cfg.SQLitePath = databasePath
	cfg.MaxSendQueueSize = 2048

	database, err := store.Open(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.RunMigrations(context.Background(), database.DB); err != nil {
		database.Close()
		t.Fatal(err)
	}

	var logs safeBuffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	server := httpapi.NewServer(cfg, database, logger)
	tlsServer := httptest.NewTLSServer(server.Handler())

	smoke := smokeConfig{
		baseURL:         tlsServer.URL,
		adminToken:      adminToken,
		hostToken:       hostToken,
		hostID:          cfg.DevAuthHostID,
		payloadSentinel: payloadSentinel,
		eventCount:      1000,
		timeout:         30 * time.Second,
	}
	ctx, cancel := context.WithTimeout(context.Background(), smoke.timeout)
	if err := runSmoke(ctx, smoke, tlsServer.Client()); err != nil {
		cancel()
		tlsServer.Close()
		database.Close()
		t.Fatal(err)
	}
	cancel()
	tlsServer.Close()
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	sqliteFiles := map[string][]byte{}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		p := databasePath + suffix
		if data, readErr := os.ReadFile(p); readErr == nil {
			sqliteFiles["sqlite"+suffix] = data
		}
	}
	if _, ok := sqliteFiles["sqlite"]; !ok {
		t.Fatalf("sqlite database file %q not found", databasePath)
	}

	for label, content := range sqliteFiles {
		for _, secret := range []string{adminToken, hostToken, payloadSentinel} {
			if bytes.Contains(content, []byte(secret)) {
				t.Fatalf("%s contains a token or payload sentinel", label)
			}
		}
	}
	for _, secret := range []string{adminToken, hostToken, payloadSentinel} {
		if bytes.Contains(logs.Bytes(), []byte(secret)) {
			t.Fatalf("logs contain a token or payload sentinel")
		}
	}
}

func TestVerifyRPCRequest_ValidationAndNegativeCases(t *testing.T) {
	reqPayload := json.RawMessage(`{"method":"conversation.list","params":{}}`)
	valid := &protocol.Envelope{
		V:       protocol.ProtocolVersion,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      "m2_smoke_rpc_1",
		HostID:  "m2_smoke_host",
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: reqPayload,
	}

	if err := verifyRPCRequest(valid, "m2_smoke_rpc_1", "m2_smoke_host", "conversation.list", json.RawMessage(`{}`)); err != nil {
		t.Fatalf("expected valid request to pass, got %v", err)
	}

	// Mismatched ID
	if err := verifyRPCRequest(valid, "different_id", "m2_smoke_host", "conversation.list", json.RawMessage(`{}`)); err == nil {
		t.Fatal("expected error on mismatched request ID")
	}

	// Mismatched HostID
	if err := verifyRPCRequest(valid, "m2_smoke_rpc_1", "different_host", "conversation.list", json.RawMessage(`{}`)); err == nil {
		t.Fatal("expected error on mismatched host ID")
	}

	// Mismatched Type
	wrongType := *valid
	wrongType.Type = protocol.FrameTypeRpcResponse
	if err := verifyRPCRequest(&wrongType, "m2_smoke_rpc_1", "m2_smoke_host", "conversation.list", json.RawMessage(`{}`)); err == nil {
		t.Fatal("expected error on mismatched frame type")
	}

	// Mismatched Version
	wrongV := *valid
	wrongV.V = 99
	if err := verifyRPCRequest(&wrongV, "m2_smoke_rpc_1", "m2_smoke_host", "conversation.list", json.RawMessage(`{}`)); err == nil {
		t.Fatal("expected error on mismatched version")
	}

	// Mismatched Method
	if err := verifyRPCRequest(valid, "m2_smoke_rpc_1", "m2_smoke_host", "conversation.get", json.RawMessage(`{}`)); err == nil {
		t.Fatal("expected error on mismatched method")
	}

	// Mismatched Params
	if err := verifyRPCRequest(valid, "m2_smoke_rpc_1", "m2_smoke_host", "conversation.list", json.RawMessage(`{"limit":10}`)); err == nil {
		t.Fatal("expected error on mismatched params")
	}
}

func TestVerifyRPCResponse_ValidationAndNegativeCases(t *testing.T) {
	respPayload, err := json.Marshal(protocol.RpcResponsePayload{
		RequestID: "m2_smoke_rpc_1",
		Ok:        true,
		Result:    json.RawMessage(`{"items":[],"nextCursor":null}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	valid := &protocol.Envelope{
		V:       protocol.ProtocolVersion,
		Type:    protocol.FrameTypeRpcResponse,
		ID:      "m2_smoke_response_1",
		HostID:  "m2_smoke_host",
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: respPayload,
	}

	expectedResult := json.RawMessage(`{"items":[],"nextCursor":null}`)
	if err := verifyRPCResponse(valid, "m2_smoke_response_1", "m2_smoke_host", "m2_smoke_rpc_1", expectedResult); err != nil {
		t.Fatalf("expected valid response to pass, got %v", err)
	}

	// Mismatched envelope ID
	if err := verifyRPCResponse(valid, "wrong_resp_id", "m2_smoke_host", "m2_smoke_rpc_1", expectedResult); err == nil {
		t.Fatal("expected error on mismatched envelope ID")
	}

	// Mismatched envelope host ID
	if err := verifyRPCResponse(valid, "m2_smoke_response_1", "wrong_host", "m2_smoke_rpc_1", expectedResult); err == nil {
		t.Fatal("expected error on mismatched envelope host ID")
	}

	// Mismatched envelope Type
	wrongType := *valid
	wrongType.Type = protocol.FrameTypeRpcRequest
	if err := verifyRPCResponse(&wrongType, "m2_smoke_response_1", "m2_smoke_host", "m2_smoke_rpc_1", expectedResult); err == nil {
		t.Fatal("expected error on mismatched type")
	}

	// Mismatched payload requestId
	if err := verifyRPCResponse(valid, "m2_smoke_response_1", "m2_smoke_host", "wrong_rpc_id", expectedResult); err == nil {
		t.Fatal("expected error on mismatched payload request ID")
	}

	// Ok is false
	failPayload, _ := json.Marshal(protocol.RpcResponsePayload{
		RequestID: "m2_smoke_rpc_1",
		Ok:        false,
		Error:     &protocol.StructuredError{Code: "host_offline", Message: "host offline"},
	})
	failResp := *valid
	failResp.Payload = failPayload
	if err := verifyRPCResponse(&failResp, "m2_smoke_response_1", "m2_smoke_host", "m2_smoke_rpc_1", expectedResult); err == nil {
		t.Fatal("expected error when response ok=false")
	}

	// Mismatched Result
	diffResult := json.RawMessage(`{"items":["tampered"]}`)
	if err := verifyRPCResponse(valid, "m2_smoke_response_1", "m2_smoke_host", "m2_smoke_rpc_1", diffResult); err == nil {
		t.Fatal("expected error on mismatched result")
	}
}

func TestVerifyEventEnvelopeAndSentinel_ValidationAndNegativeCases(t *testing.T) {
	sentinel := "secret_sentinel_xyz123"
	token := "secret_token_abc456"

	makeEvent := func(seqVal int64, hostID string, itemContent string, itemKind string, itemRole string, runID string) *protocol.Envelope {
		var sVal *int64
		if seqVal >= 0 {
			sVal = &seqVal
		}
		data := fmt.Sprintf(`{"runId":%q,"item":{"kind":%q,"role":%q,"content":%q}}`, runID, itemKind, itemRole, itemContent)
		p, _ := json.Marshal(protocol.EventPayload{
			Name: "run.stream",
			Data: json.RawMessage(data),
		})
		id := "m2_smoke_event_000001"
		if seqVal >= 0 {
			id = fmt.Sprintf("m2_smoke_event_%06d", seqVal)
		}
		return &protocol.Envelope{
			V:       protocol.ProtocolVersion,
			Type:    protocol.FrameTypeEvent,
			ID:      id,
			HostID:  hostID,
			SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
			Seq:     sVal,
			Payload: p,
		}
	}

	valid := makeEvent(1, "host_1", sentinel, "text", "assistant", "m2_smoke_run")
	if err := verifyEventEnvelopeAndSentinel(valid, 1, "host_1", sentinel); err != nil {
		t.Fatalf("expected valid event to pass, got %v", err)
	}

	testCases := []struct {
		name             string
		env              *protocol.Envelope
		expectedSeq      int64
		expectedHost     string
		expectedSentinel string
	}{
		{
			name:             "tampered_sentinel",
			env:              makeEvent(1, "host_1", "tampered_sentinel_val", "text", "assistant", "m2_smoke_run"),
			expectedSeq:      1,
			expectedHost:     "host_1",
			expectedSentinel: sentinel,
		},
		{
			name:             "missing_sentinel",
			env:              makeEvent(1, "host_1", "", "text", "assistant", "m2_smoke_run"),
			expectedSeq:      1,
			expectedHost:     "host_1",
			expectedSentinel: sentinel,
		},
		{
			name:             "mismatched_host",
			env:              makeEvent(1, "wrong_host", sentinel, "text", "assistant", "m2_smoke_run"),
			expectedSeq:      1,
			expectedHost:     "host_1",
			expectedSentinel: sentinel,
		},
		{
			name:             "mismatched_seq",
			env:              makeEvent(2, "host_1", sentinel, "text", "assistant", "m2_smoke_run"),
			expectedSeq:      1,
			expectedHost:     "host_1",
			expectedSentinel: sentinel,
		},
		{
			name:             "missing_seq",
			env:              makeEvent(-1, "host_1", sentinel, "text", "assistant", "m2_smoke_run"),
			expectedSeq:      1,
			expectedHost:     "host_1",
			expectedSentinel: sentinel,
		},
		{
			name:             "wrong_kind",
			env:              makeEvent(1, "host_1", sentinel, "binary", "assistant", "m2_smoke_run"),
			expectedSeq:      1,
			expectedHost:     "host_1",
			expectedSentinel: sentinel,
		},
		{
			name:             "wrong_role",
			env:              makeEvent(1, "host_1", sentinel, "text", "user", "m2_smoke_run"),
			expectedSeq:      1,
			expectedHost:     "host_1",
			expectedSentinel: sentinel,
		},
		{
			name:             "wrong_run_id",
			env:              makeEvent(1, "host_1", sentinel, "text", "assistant", "different_run"),
			expectedSeq:      1,
			expectedHost:     "host_1",
			expectedSentinel: sentinel,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			err := verifyEventEnvelopeAndSentinel(tc.env, tc.expectedSeq, tc.expectedHost, tc.expectedSentinel)
			if err == nil {
				t.Fatalf("%s: expected verification error", tc.name)
			}
			sanitized := sanitizeError(err, sentinel, token)
			errStr := sanitized.Error()
			if strings.Contains(errStr, sentinel) {
				t.Fatalf("%s: error leaked sentinel value %q: %s", tc.name, sentinel, errStr)
			}
			if strings.Contains(errStr, token) {
				t.Fatalf("%s: error leaked token value %q: %s", tc.name, token, errStr)
			}
			if strings.Contains(errStr, "tampered_sentinel_val") {
				t.Fatalf("%s: error leaked tampered sentinel value: %s", tc.name, errStr)
			}
		})
	}
}

func TestSanitizeErrorRedactsSecrets(t *testing.T) {
	secret1 := "my_ultra_secret_token_12345"
	secret2 := "my_sentinel_marker_67890"

	err := fmt.Errorf("failed with token=%s and sentinel=%s", secret1, secret2)
	sanitized := sanitizeError(err, secret1, secret2)
	if sanitized == nil {
		t.Fatal("expected non-nil error")
	}
	if strings.Contains(sanitized.Error(), secret1) {
		t.Fatal("sanitized error still contains secret1")
	}
	if strings.Contains(sanitized.Error(), secret2) {
		t.Fatal("sanitized error still contains secret2")
	}
	if !strings.Contains(sanitized.Error(), "[REDACTED]") {
		t.Fatal("sanitized error missing [REDACTED]")
	}
}

func TestWebsocketBaseURLRequiresTLS(t *testing.T) {
	parsed, err := websocketBaseURL("https://remote.example.com/base/")
	if err != nil {
		t.Fatal(err)
	}
	if parsed.String() != "wss://remote.example.com/base" {
		t.Fatalf("unexpected WSS URL %q", parsed.String())
	}

	for _, invalid := range []string{
		"http://remote.example.com",
		"ws://remote.example.com",
		"https://remote.example.com?token=forbidden",
		"https://remote.example.com#fragment",
	} {
		if _, err := websocketBaseURL(invalid); err == nil {
			t.Fatalf("expected URL %q to be rejected", invalid)
		}
	}
}

func TestValidateSmokeConfigDoesNotEchoSecrets(t *testing.T) {
	secret := strings.Repeat("s", 42)
	err := validateSmokeConfig(smokeConfig{
		baseURL:         "https://remote.example.com",
		adminToken:      secret,
		hostToken:       secret,
		hostID:          "host_1",
		payloadSentinel: "payload",
		eventCount:      1,
		timeout:         time.Second,
	})
	if err == nil {
		t.Fatal("expected short tokens to be rejected")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatal("validation error echoed a token")
	}
}

func randomBase64URL(t *testing.T, size int) string {
	t.Helper()
	random := make([]byte, size)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(random)
	if encoded == "" {
		t.Fatal(fmt.Errorf("failed to encode random value"))
	}
	return encoded
}

type safeBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *safeBuffer) Write(p []byte) (n int, err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *safeBuffer) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	cp := make([]byte, b.buf.Len())
	copy(cp, b.buf.Bytes())
	return cp
}

func TestParseBaseURLs_LoopbackBoundaries(t *testing.T) {
	// Case 1: Loopback IP literals with allowLoopbackWS = true
	validLoopbacks := []struct {
		input        string
		expectedWS   string
		expectedHTTP string
	}{
		{"http://127.0.0.1:8080", "ws://127.0.0.1:8080", "http://127.0.0.1:8080"},
		{"ws://127.0.0.1:8080", "ws://127.0.0.1:8080", "http://127.0.0.1:8080"},
		{"http://127.0.0.2:9000", "ws://127.0.0.2:9000", "http://127.0.0.2:9000"},
		{"http://[::1]:8080", "ws://[::1]:8080", "http://[::1]:8080"},
		{"ws://[::1]:8080", "ws://[::1]:8080", "http://[::1]:8080"},
		{"http://127.0.0.1:8080/prefix", "ws://127.0.0.1:8080/prefix", "http://127.0.0.1:8080/prefix"},
	}
	for _, tc := range validLoopbacks {
		ws, httpBase, err := parseBaseURLs(tc.input, true)
		if err != nil {
			t.Fatalf("expected valid loopback URL %q to pass, got err: %v", tc.input, err)
		}
		if ws.String() != tc.expectedWS {
			t.Errorf("for input %q: expected WS %q, got %q", tc.input, tc.expectedWS, ws.String())
		}
		if httpBase.String() != tc.expectedHTTP {
			t.Errorf("for input %q: expected HTTP %q, got %q", tc.input, tc.expectedHTTP, httpBase.String())
		}
	}

	// Case 2: Rejected inputs with allowLoopbackWS = true (non-IP literals or non-loopback)
	invalidWithLoopbackFlag := []string{
		"http://localhost:8080",      // Hostname, not IP literal
		"ws://localhost:8080",        // Hostname, not IP literal
		"http://localhost",           // Hostname, not IP literal
		"http://192.168.1.1:8080",    // Private non-loopback IP
		"http://10.0.0.1:8080",       // Private non-loopback IP
		"http://0.0.0.0:8080",        // Unspecified/all interfaces IP
		"http://[::]:8080",           // IPv6 unspecified
		"http://remote.example.com",  // Remote domain
		"ftp://127.0.0.1:8080",       // Unsupported scheme
		"http://127.0.0.1:8080?q=1",  // Query string forbidden
		"http://127.0.0.1:8080#frag", // Fragment forbidden
	}
	for _, inv := range invalidWithLoopbackFlag {
		if _, _, err := parseBaseURLs(inv, true); err == nil {
			t.Errorf("expected URL %q to be rejected with allowLoopbackWS=true, but got no error", inv)
		}
	}

	// Case 3: Rejected unencrypted inputs when allowLoopbackWS = false
	invalidWithoutLoopbackFlag := []string{
		"http://127.0.0.1:8080",
		"ws://127.0.0.1:8080",
		"http://[::1]:8080",
		"ws://[::1]:8080",
		"http://localhost:8080",
		"ws://localhost:8080",
	}
	for _, inv := range invalidWithoutLoopbackFlag {
		if _, _, err := parseBaseURLs(inv, false); err == nil {
			t.Errorf("expected unencrypted URL %q to be rejected when allowLoopbackWS=false, but got no error", inv)
		}
	}

	// Case 4: TLS URLs allowed with or without allowLoopbackWS
	validTLS := []string{
		"https://remote.example.com",
		"wss://remote.example.com",
		"https://127.0.0.1:8443",
	}
	for _, tlsURL := range validTLS {
		if _, _, err := parseBaseURLs(tlsURL, false); err != nil {
			t.Errorf("expected TLS URL %q to pass with allowLoopbackWS=false, got err: %v", tlsURL, err)
		}
		if _, _, err := parseBaseURLs(tlsURL, true); err != nil {
			t.Errorf("expected TLS URL %q to pass with allowLoopbackWS=true, got err: %v", tlsURL, err)
		}
	}
}

func TestRedirectsForbidden(t *testing.T) {
	redirectTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer redirectTarget.Close()

	redirectingServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, redirectTarget.URL+r.URL.Path, http.StatusFound)
	}))
	defer redirectingServer.Close()

	client := createHTTPClient(nil, 5*time.Second)

	parsed, err := url.Parse(redirectingServer.URL)
	if err != nil {
		t.Fatal(err)
	}
	err = checkHealthAndReady(context.Background(), client, parsed)
	if err == nil {
		t.Fatal("expected redirecting server to trigger redirect forbidden error, but probe succeeded")
	}
	if !strings.Contains(err.Error(), "redirects are forbidden") {
		t.Fatalf("expected error mentioning 'redirects are forbidden', got: %v", err)
	}
}

func TestEnvFileLoading(t *testing.T) {
	tempDir := t.TempDir()
	envPath := filepath.Join(tempDir, "dev.env")

	adminToken := randomBase64URL(t, 32)
	hostToken := randomBase64URL(t, 32)

	content := fmt.Sprintf("DEV_AUTH_ADMIN_TOKEN=%s\nDEV_AUTH_HOST_TOKEN=%s\nDEV_AUTH_HOST_ID=custom_host\n", adminToken, hostToken)
	if err := os.WriteFile(envPath, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}

	var cfg smokeConfig
	if err := loadTokensFromEnvFile(envPath, &cfg); err != nil {
		t.Fatalf("failed to load 0600 env file: %v", err)
	}
	if cfg.adminToken != adminToken {
		t.Errorf("admin token mismatch")
	}
	if cfg.hostToken != hostToken {
		t.Errorf("host token mismatch")
	}
	if cfg.hostID != "custom_host" {
		t.Errorf("host ID mismatch")
	}

	// 0400 permissions test (read-only owner)
	p400 := filepath.Join(tempDir, "readonly.env")
	if err := os.WriteFile(p400, []byte(content), 0400); err != nil {
		t.Fatal(err)
	}
	var cfg400 smokeConfig
	if err := loadTokensFromEnvFile(p400, &cfg400); err != nil {
		t.Fatalf("expected 0400 env file to be accepted, got: %v", err)
	}
	if cfg400.adminToken != adminToken {
		t.Errorf("admin token mismatch on 0400 file")
	}

	// Overly permissive permissions test (world readable 0644)
	permissivePath := filepath.Join(tempDir, "permissive.env")
	if err := os.WriteFile(permissivePath, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(permissivePath, 0644)
	var permissiveCfg smokeConfig
	if err := loadTokensFromEnvFile(permissivePath, &permissiveCfg); err == nil {
		t.Fatal("expected loadTokensFromEnvFile to reject world-readable permissions (0644)")
	}

	// Group-readable permissions test (0640)
	groupPath := filepath.Join(tempDir, "group_readable.env")
	if err := os.WriteFile(groupPath, []byte(content), 0640); err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(groupPath, 0640)
	var groupCfg smokeConfig
	if err := loadTokensFromEnvFile(groupPath, &groupCfg); err == nil {
		t.Fatal("expected loadTokensFromEnvFile to reject group-readable permissions (0640)")
	}

	// Symlink test
	symlinkPath := filepath.Join(tempDir, "symlink.env")
	if err := os.Symlink(envPath, symlinkPath); err != nil {
		t.Fatal(err)
	}
	var symlinkCfg smokeConfig
	if err := loadTokensFromEnvFile(symlinkPath, &symlinkCfg); err == nil {
		t.Fatal("expected loadTokensFromEnvFile to reject symlink env file")
	}
}

func TestRealLocalTCP_HealthAnd1000Events(t *testing.T) {
	adminToken := randomBase64URL(t, 32)
	hostToken := randomBase64URL(t, 32)
	payloadSentinel := "local_tcp_payload_" + randomBase64URL(t, 18)
	databasePath := filepath.Join(t.TempDir(), "local_relay.db")

	cfg := config.DefaultConfig()
	cfg.DevAuthMode = true
	cfg.DevAuthAdminToken = adminToken
	cfg.DevAuthHostToken = hostToken
	cfg.DevAuthHostID = "local_tcp_host"
	cfg.SQLitePath = databasePath
	cfg.MaxSendQueueSize = 2048

	// Bind real TCP port on 127.0.0.1
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to bind loopback TCP port: %v", err)
	}
	cfg.ListenAddr = listener.Addr().String()

	database, err := store.Open(databasePath)
	if err != nil {
		listener.Close()
		t.Fatal(err)
	}
	if err := store.RunMigrations(context.Background(), database.DB); err != nil {
		database.Close()
		listener.Close()
		t.Fatal(err)
	}

	var logs safeBuffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	server := httpapi.NewServer(cfg, database, logger)

	httpServer := &http.Server{
		Handler: server.Handler(),
	}

	serverDone := make(chan error, 1)
	go func() {
		serverDone <- httpServer.Serve(listener)
	}()

	// Real smoke test over loopback TCP using http://127.0.0.1:<port>
	smoke := smokeConfig{
		baseURL:         "http://" + listener.Addr().String(),
		adminToken:      adminToken,
		hostToken:       hostToken,
		hostID:          cfg.DevAuthHostID,
		payloadSentinel: payloadSentinel,
		eventCount:      1000,
		timeout:         30 * time.Second,
		allowLoopbackWS: true,
	}

	ctx, cancel := context.WithTimeout(context.Background(), smoke.timeout)
	smokeErr := runSmoke(ctx, smoke, http.DefaultClient)
	cancel()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	_ = httpServer.Shutdown(shutdownCtx)
	shutdownCancel()
	_ = database.Close()

	if smokeErr != nil {
		t.Fatalf("real loopback TCP smoke failed: %v", smokeErr)
	}

	// Verify zero retention in SQLite
	sqliteFiles := map[string][]byte{}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		p := databasePath + suffix
		if data, readErr := os.ReadFile(p); readErr == nil {
			sqliteFiles["sqlite"+suffix] = data
		}
	}
	for label, content := range sqliteFiles {
		for _, secret := range []string{adminToken, hostToken, payloadSentinel} {
			if bytes.Contains(content, []byte(secret)) {
				t.Fatalf("%s contains a token or payload sentinel", label)
			}
		}
	}
	// Verify zero retention in logs
	for _, secret := range []string{adminToken, hostToken, payloadSentinel} {
		if bytes.Contains(logs.Bytes(), []byte(secret)) {
			t.Fatalf("logs contain a token or payload sentinel")
		}
	}
}

func TestRealLocalProcessExecution(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping slow process execution test in short mode")
	}

	tempDir := t.TempDir()
	binPath := filepath.Join(tempDir, "relay_bin")

	// Compile relay binary
	buildCmd := exec.Command("go", "build", "-o", binPath, "./cmd/relay")
	buildCmd.Dir = filepath.Join(".", "..", "..") // services/remote-relay root
	if out, err := buildCmd.CombinedOutput(); err != nil {
		t.Fatalf("failed to build relay binary: %v, output: %s", err, string(out))
	}

	adminToken := randomBase64URL(t, 32)
	hostToken := randomBase64URL(t, 32)
	payloadSentinel := "process_test_sentinel_" + randomBase64URL(t, 18)
	databasePath := filepath.Join(tempDir, "process_relay.db")

	// Find free port on 127.0.0.1
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to allocate free port: %v", err)
	}
	addr := l.Addr().String()
	l.Close()

	var processLogs safeBuffer
	cmd := exec.Command(binPath)
	cmd.Stdout = &processLogs
	cmd.Stderr = &processLogs
	cmd.Env = append(os.Environ(),
		"DEV_AUTH_MODE=true",
		"DEV_AUTH_ADMIN_TOKEN="+adminToken,
		"DEV_AUTH_HOST_TOKEN="+hostToken,
		"DEV_AUTH_HOST_ID=process_test_host",
		"LISTEN_ADDR="+addr,
		"SQLITE_PATH="+databasePath,
		"LOG_LEVEL=info",
		"LOG_FORMAT=json",
		"MAX_SEND_QUEUE_SIZE=2048",
	)

	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start relay process: %v", err)
	}
	defer func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	}()

	// Wait for /readyz
	readyURL := fmt.Sprintf("http://%s/readyz", addr)
	ready := false
	for i := 0; i < 50; i++ {
		time.Sleep(100 * time.Millisecond)
		resp, err := http.Get(readyURL)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				ready = true
				break
			}
		}
	}
	if !ready {
		t.Fatalf("process failed to become ready at %s; logs:\n%s", readyURL, processLogs.Bytes())
	}

	// Run smoke test against the live process
	smoke := smokeConfig{
		baseURL:         "http://" + addr,
		adminToken:      adminToken,
		hostToken:       hostToken,
		hostID:          "process_test_host",
		payloadSentinel: payloadSentinel,
		eventCount:      1000,
		timeout:         30 * time.Second,
		allowLoopbackWS: true,
	}
	ctx, cancel := context.WithTimeout(context.Background(), smoke.timeout)
	smokeErr := runSmoke(ctx, smoke, http.DefaultClient)
	cancel()

	// Send SIGTERM to test graceful shutdown
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("failed to signal process: %v", err)
	}

	waitErr := make(chan error, 1)
	go func() {
		waitErr <- cmd.Wait()
	}()

	select {
	case err := <-waitErr:
		if err != nil {
			t.Fatalf("process exited with error: %v", err)
		}
	case <-time.After(10 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("process did not terminate gracefully within 10s of SIGTERM")
	}

	if smokeErr != nil {
		t.Fatalf("smoke verification against live process failed: %v", smokeErr)
	}

	// Audit SQLite files for data boundary violations
	sqliteFiles := map[string][]byte{}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		p := databasePath + suffix
		if data, readErr := os.ReadFile(p); readErr == nil {
			sqliteFiles["sqlite"+suffix] = data
		}
	}
	for label, content := range sqliteFiles {
		for _, secret := range []string{adminToken, hostToken, payloadSentinel} {
			if bytes.Contains(content, []byte(secret)) {
				t.Fatalf("%s contains a token or payload sentinel", label)
			}
		}
	}
	// Audit process stdout/stderr logs for zero leakage
	for _, secret := range []string{adminToken, hostToken, payloadSentinel} {
		if bytes.Contains(processLogs.Bytes(), []byte(secret)) {
			t.Fatalf("live process logs contain sensitive marker %q", secret)
		}
	}
}
