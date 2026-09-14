package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/config"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/protocol"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/store"
)

const (
	testDevAdminToken = "dev-admin-secret-token-32chars-ok"
	testDevHostToken  = "dev-host-secret-token-32chars-ok"
	testDevHostID     = "host_dev"
)

// setupE2ETLSServer creates a real TLS HTTP test server running Relay with DEV_AUTH_MODE enabled.
func setupE2ETLSServer(t *testing.T, modifyCfg func(c *config.Config)) (*httptest.Server, *Server, config.Config) {
	t.Helper()

	cfg := config.DefaultConfig()
	cfg.DevAuthMode = true
	cfg.DevAuthAdminToken = testDevAdminToken
	cfg.DevAuthHostToken = testDevHostToken
	cfg.DevAuthHostID = testDevHostID
	cfg.RPCTimeout = 2 * time.Second
	cfg.ShutdownGracePeriod = 2 * time.Second

	if modifyCfg != nil {
		modifyCfg(&cfg)
	}

	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("failed to open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	srv := NewServer(cfg, db, logger)

	ts := httptest.NewTLSServer(srv.Handler())
	t.Cleanup(func() { ts.Close() })

	return ts, srv, cfg
}

// dialWS connects to the WSS endpoint using the test server's TLS client.
func dialWS(ctx context.Context, ts *httptest.Server, path string, headers http.Header) (*websocket.Conn, *http.Response, error) {
	wsURL := "wss://" + ts.Listener.Addr().String() + path
	opts := &websocket.DialOptions{
		HTTPClient: ts.Client(),
		HTTPHeader: headers,
	}
	return websocket.Dial(ctx, wsURL, opts)
}

func sendJSONEnvelope(ctx context.Context, ws *websocket.Conn, env *protocol.Envelope) error {
	data, err := protocol.EncodeEnvelope(env)
	if err != nil {
		return err
	}
	return ws.Write(ctx, websocket.MessageText, data)
}

func readJSONEnvelope(ctx context.Context, ws *websocket.Conn) (*protocol.Envelope, error) {
	msgType, data, err := ws.Read(ctx)
	if err != nil {
		return nil, err
	}
	if msgType != websocket.MessageText {
		return nil, fmt.Errorf("unexpected non-text websocket frame: %v", msgType)
	}
	return protocol.DecodeEnvelope(data)
}

// connectAndAuthAdmin establishes and authenticates an Admin connection.
func connectAndAuthAdmin(t *testing.T, ctx context.Context, ts *httptest.Server, token string) *websocket.Conn {
	t.Helper()
	ws, _, err := dialWS(ctx, ts, "/v1/ws/admin", nil)
	if err != nil {
		t.Fatalf("failed to dial admin ws: %v", err)
	}

	authEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeAdminAuth,
		ID:      protocol.GenerateMessageID(),
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(fmt.Sprintf(`{"accessToken":%q,"clientVersion":"1.0.0","protocolVersion":1}`, token)),
	}

	if err := sendJSONEnvelope(ctx, ws, authEnv); err != nil {
		_ = ws.Close(websocket.StatusGoingAway, "err")
		t.Fatalf("failed to send admin.auth: %v", err)
	}

	resp, err := readJSONEnvelope(ctx, ws)
	if err != nil {
		_ = ws.Close(websocket.StatusGoingAway, "err")
		t.Fatalf("failed to read admin auth response: %v", err)
	}

	if resp.Type != protocol.FrameTypeAuthOk {
		_ = ws.Close(websocket.StatusGoingAway, "err")
		t.Fatalf("expected auth.ok frame for admin, got %s: %s", resp.Type, string(resp.Payload))
	}

	return ws
}

// connectAndAuthHost establishes and authenticates a Host connection using DEV host token.
func connectAndAuthHost(t *testing.T, ctx context.Context, ts *httptest.Server, hostID string, token string) *websocket.Conn {
	t.Helper()
	hdr := http.Header{}
	if token != "" {
		hdr.Set("Authorization", "Bearer "+token)
	}
	if hostID != "" {
		hdr.Set("X-Host-Id", hostID)
	}
	ws, _, err := dialWS(ctx, ts, "/v1/ws/host", hdr)
	if err != nil {
		t.Fatalf("failed to dial host ws: %v", err)
	}

	resp, err := readJSONEnvelope(ctx, ws)
	if err != nil {
		_ = ws.Close(websocket.StatusGoingAway, "err")
		t.Fatalf("failed to read host auth response: %v", err)
	}
	if resp.Type != protocol.FrameTypeAuthOk {
		_ = ws.Close(websocket.StatusGoingAway, "err")
		t.Fatalf("expected auth.ok frame for host, got %s: %s", resp.Type, string(resp.Payload))
	}

	var authOkPayload protocol.AuthOkPayload
	if err := json.Unmarshal(resp.Payload, &authOkPayload); err != nil {
		_ = ws.Close(websocket.StatusGoingAway, "err")
		t.Fatalf("failed to parse auth.ok payload: %v", err)
	}
	if authOkPayload.Limits.MaxFrameBytes != protocol.MaxAllowedFrameBytes {
		_ = ws.Close(websocket.StatusGoingAway, "err")
		t.Fatalf("expected auth.ok maxFrameBytes to be fixed constant %d, got %d", protocol.MaxAllowedFrameBytes, authOkPayload.Limits.MaxFrameBytes)
	}

	return ws
}

func TestE2E_DevAuth_AdminAndHost(t *testing.T) {
	ts, _, _ := setupE2ETLSServer(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// 1. Admin valid token auth via admin.auth frame
	adminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS.Close(websocket.StatusNormalClosure, "test_done")

	// 2. Admin invalid token auth -> rejected
	badAdminWS, _, err := dialWS(ctx, ts, "/v1/ws/admin", nil)
	if err != nil {
		t.Fatalf("failed to dial admin ws: %v", err)
	}
	badAuthEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeAdminAuth,
		ID:      protocol.GenerateMessageID(),
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"accessToken":"wrong-token-1234567890123456789012","clientVersion":"1.0.0","protocolVersion":1}`),
	}
	_ = sendJSONEnvelope(ctx, badAdminWS, badAuthEnv)
	errEnv, err := readJSONEnvelope(ctx, badAdminWS)
	if err != nil {
		t.Fatalf("expected error envelope on bad auth, got error: %v", err)
	}
	if errEnv.Type != protocol.FrameTypeError {
		t.Fatalf("expected error envelope type, got %s", errEnv.Type)
	}
	var sErr protocol.StructuredError
	_ = json.Unmarshal(errEnv.Payload, &sErr)
	if sErr.Code != protocol.ErrCodeUnauthorized {
		t.Fatalf("expected unauthorized error code, got %s", sErr.Code)
	}
	badAdminWS.Close(websocket.StatusNormalClosure, "done")

	// 3. Admin header-based dev auth (Authorization: Bearer)
	hdr := http.Header{}
	hdr.Set("Authorization", "Bearer "+testDevAdminToken)
	adminHeaderWS, _, err := dialWS(ctx, ts, "/v1/ws/admin", hdr)
	if err != nil {
		t.Fatalf("failed to dial admin ws with auth header: %v", err)
	}
	authOkEnv, err := readJSONEnvelope(ctx, adminHeaderWS)
	if err != nil || authOkEnv.Type != protocol.FrameTypeAuthOk {
		t.Fatalf("expected auth.ok for header-authenticated admin, got %v (err: %v)", authOkEnv, err)
	}
	var adminOkPayload protocol.AuthOkPayload
	_ = json.Unmarshal(authOkEnv.Payload, &adminOkPayload)
	if adminOkPayload.Limits.MaxFrameBytes != protocol.MaxAllowedFrameBytes {
		t.Fatalf("expected admin auth.ok maxFrameBytes %d, got %d", protocol.MaxAllowedFrameBytes, adminOkPayload.Limits.MaxFrameBytes)
	}
	adminHeaderWS.Close(websocket.StatusNormalClosure, "done")

	// 4. Admin header-based dev auth (X-Dev-Admin-Token)
	hdr2 := http.Header{}
	hdr2.Set("X-Dev-Admin-Token", testDevAdminToken)
	adminHeader2WS, _, err := dialWS(ctx, ts, "/v1/ws/admin", hdr2)
	if err != nil {
		t.Fatalf("failed to dial admin ws with X-Dev-Admin-Token header: %v", err)
	}
	authOkEnv2, err := readJSONEnvelope(ctx, adminHeader2WS)
	if err != nil || authOkEnv2.Type != protocol.FrameTypeAuthOk {
		t.Fatalf("expected auth.ok for X-Dev-Admin-Token admin, got %v (err: %v)", authOkEnv2, err)
	}
	adminHeader2WS.Close(websocket.StatusNormalClosure, "done")

	// 5. Host valid auth via Authorization: Bearer with matching X-Host-Id
	hostHdr := http.Header{}
	hostHdr.Set("Authorization", "Bearer "+testDevHostToken)
	hostHdr.Set("X-Host-Id", testDevHostID)
	hostHdrWS, _, err := dialWS(ctx, ts, "/v1/ws/host", hostHdr)
	if err != nil {
		t.Fatalf("failed to dial host ws with auth header: %v", err)
	}
	hostHdrOkEnv, err := readJSONEnvelope(ctx, hostHdrWS)
	if err != nil || hostHdrOkEnv.Type != protocol.FrameTypeAuthOk {
		t.Fatalf("expected auth.ok for header-authenticated host, got %v (err: %v)", hostHdrOkEnv, err)
	}
	var hostOkPayload protocol.AuthOkPayload
	_ = json.Unmarshal(hostHdrOkEnv.Payload, &hostOkPayload)
	if hostOkPayload.HostID != testDevHostID {
		t.Fatalf("expected hostId %s, got %s", testDevHostID, hostOkPayload.HostID)
	}
	if hostOkPayload.Limits.MaxFrameBytes != protocol.MaxAllowedFrameBytes {
		t.Fatalf("expected host auth.ok maxFrameBytes %d, got %d", protocol.MaxAllowedFrameBytes, hostOkPayload.Limits.MaxFrameBytes)
	}
	hostHdrWS.Close(websocket.StatusNormalClosure, "done")

	// 6. Host valid auth via X-Dev-Host-Token
	hostHdr2 := http.Header{}
	hostHdr2.Set("X-Dev-Host-Token", testDevHostToken)
	hostHdr2WS, _, err := dialWS(ctx, ts, "/v1/ws/host", hostHdr2)
	if err != nil {
		t.Fatalf("failed to dial host ws with X-Dev-Host-Token header: %v", err)
	}
	hostHdr2OkEnv, err := readJSONEnvelope(ctx, hostHdr2WS)
	if err != nil || hostHdr2OkEnv.Type != protocol.FrameTypeAuthOk {
		t.Fatalf("expected auth.ok for X-Dev-Host-Token host, got %v (err: %v)", hostHdr2OkEnv, err)
	}
	hostHdr2WS.Close(websocket.StatusNormalClosure, "done")

	// 7. Host valid auth with NO X-Host-Id (binds to DevAuthHostID automatically)
	hostHdr3 := http.Header{}
	hostHdr3.Set("Authorization", "Bearer "+testDevHostToken)
	hostHdr3WS, _, err := dialWS(ctx, ts, "/v1/ws/host", hostHdr3)
	if err != nil {
		t.Fatalf("failed to dial host ws without X-Host-Id: %v", err)
	}
	hostHdr3OkEnv, err := readJSONEnvelope(ctx, hostHdr3WS)
	if err != nil || hostHdr3OkEnv.Type != protocol.FrameTypeAuthOk {
		t.Fatalf("expected auth.ok for host without X-Host-Id header: %v (err: %v)", hostHdr3OkEnv, err)
	}
	var hostOk3Payload protocol.AuthOkPayload
	_ = json.Unmarshal(hostHdr3OkEnv.Payload, &hostOk3Payload)
	if hostOk3Payload.HostID != testDevHostID {
		t.Fatalf("expected hostId to bind to DevAuthHostID %s, got %s", testDevHostID, hostOk3Payload.HostID)
	}
	hostHdr3WS.Close(websocket.StatusNormalClosure, "done")

	// 8. Host rejection: mismatched self-reported X-Host-Id (Task B requirement)
	hostMismatchHdr := http.Header{}
	hostMismatchHdr.Set("Authorization", "Bearer "+testDevHostToken)
	hostMismatchHdr.Set("X-Host-Id", "host_mismatched_001")
	hostMismatchWS, _, err := dialWS(ctx, ts, "/v1/ws/host", hostMismatchHdr)
	if err != nil {
		t.Fatalf("failed to dial host ws: %v", err)
	}
	mismatchErrEnv, err := readJSONEnvelope(ctx, hostMismatchWS)
	if err != nil || mismatchErrEnv.Type != protocol.FrameTypeError {
		t.Fatalf("expected error envelope rejecting mismatched hostId, got %v (err: %v)", mismatchErrEnv, err)
	}
	var mismatchErr protocol.StructuredError
	_ = json.Unmarshal(mismatchErrEnv.Payload, &mismatchErr)
	if mismatchErr.Code != protocol.ErrCodeUnauthorized {
		t.Fatalf("expected unauthorized error for mismatched hostId, got %s", mismatchErr.Code)
	}
	hostMismatchWS.Close(websocket.StatusNormalClosure, "done")

	// 9. Host rejection: mismatched self-reported query host_id
	queryHdr := http.Header{}
	queryHdr.Set("Authorization", "Bearer "+testDevHostToken)
	hostQueryMismatchWS, _, err := dialWS(ctx, ts, "/v1/ws/host?host_id=host_mismatched_002", queryHdr)
	if err != nil {
		t.Fatalf("failed to dial host ws with query host_id: %v", err)
	}
	queryMismatchErrEnv, err := readJSONEnvelope(ctx, hostQueryMismatchWS)
	if err != nil || queryMismatchErrEnv.Type != protocol.FrameTypeError {
		t.Fatalf("expected error envelope rejecting mismatched query host_id, got %v (err: %v)", queryMismatchErrEnv, err)
	}
	hostQueryMismatchWS.Close(websocket.StatusNormalClosure, "done")

	// 10. Host rejection: invalid host token
	badTokenHdr := http.Header{}
	badTokenHdr.Set("Authorization", "Bearer wrong-host-token-1234567890123456")
	badHostTokenWS, _, err := dialWS(ctx, ts, "/v1/ws/host", badTokenHdr)
	if err != nil {
		t.Fatalf("failed to dial host ws with bad token: %v", err)
	}
	badTokenErrEnv, err := readJSONEnvelope(ctx, badHostTokenWS)
	if err != nil || badTokenErrEnv.Type != protocol.FrameTypeError {
		t.Fatalf("expected error envelope for bad host token, got %v (err: %v)", badTokenErrEnv, err)
	}
	badHostTokenWS.Close(websocket.StatusNormalClosure, "done")

	// 11. Host rejection: connection without token (Task A: fail-closed, no challenge)
	noTokenWS, _, err := dialWS(ctx, ts, "/v1/ws/host", nil)
	if err != nil {
		t.Fatalf("failed to dial host ws without token: %v", err)
	}
	noTokenErrEnv, err := readJSONEnvelope(ctx, noTokenWS)
	if err != nil || noTokenErrEnv.Type != protocol.FrameTypeError {
		t.Fatalf("expected error envelope for host without token, got %v (err: %v)", noTokenErrEnv, err)
	}
	noTokenWS.Close(websocket.StatusNormalClosure, "done")
}

func TestE2E_FullRPCRoundTrip(t *testing.T) {
	ts, _, _ := setupE2ETLSServer(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	hostID := testDevHostID
	hostWS := connectAndAuthHost(t, ctx, ts, hostID, testDevHostToken)
	defer hostWS.Close(websocket.StatusNormalClosure, "done")

	adminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS.Close(websocket.StatusNormalClosure, "done")

	// 1. Admin sends rpc.request
	reqID := "req_read_001"
	rpcReq := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      reqID,
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"method":"conversation.list","params":{}}`),
	}

	if err := sendJSONEnvelope(ctx, adminWS, rpcReq); err != nil {
		t.Fatalf("failed to send rpc.request: %v", err)
	}

	// 2. Host receives rpc.request
	hostReceivedEnv, err := readJSONEnvelope(ctx, hostWS)
	if err != nil {
		t.Fatalf("host failed to read rpc.request: %v", err)
	}
	if hostReceivedEnv.Type != protocol.FrameTypeRpcRequest || hostReceivedEnv.ID != reqID {
		t.Fatalf("host received unexpected frame: %s (id: %s)", hostReceivedEnv.Type, hostReceivedEnv.ID)
	}

	// 3. Host replies with rpc.response
	rpcResp := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcResponse,
		ID:      protocol.GenerateMessageID(),
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(fmt.Sprintf(`{"requestId":%q,"ok":true,"result":{"conversations":[{"id":"conv_1"}]}}`, reqID)),
	}

	if err := sendJSONEnvelope(ctx, hostWS, rpcResp); err != nil {
		t.Fatalf("host failed to send rpc.response: %v", err)
	}

	// 4. Admin receives rpc.response
	adminReceivedEnv, err := readJSONEnvelope(ctx, adminWS)
	if err != nil {
		t.Fatalf("admin failed to read rpc.response: %v", err)
	}
	if adminReceivedEnv.Type != protocol.FrameTypeRpcResponse {
		t.Fatalf("admin received unexpected frame type: %s", adminReceivedEnv.Type)
	}

	var respPayload protocol.RpcResponsePayload
	if err := json.Unmarshal(adminReceivedEnv.Payload, &respPayload); err != nil {
		t.Fatalf("failed to unmarshal rpc response payload: %v", err)
	}
	if respPayload.RequestID != reqID || !respPayload.Ok {
		t.Fatalf("admin received invalid rpc response: %+v", respPayload)
	}
}

func TestE2E_WriteRPC_WithIdempotencyAndExpiry(t *testing.T) {
	ts, _, _ := setupE2ETLSServer(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	hostID := testDevHostID
	hostWS := connectAndAuthHost(t, ctx, ts, hostID, testDevHostToken)
	defer hostWS.Close(websocket.StatusNormalClosure, "done")

	adminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS.Close(websocket.StatusNormalClosure, "done")

	reqID := "req_write_001"
	expiresAt := time.Now().Add(10 * time.Second).UTC().Format(time.RFC3339Nano)
	idempotencyKey := "idem_key_12345678901234567890"

	writeReq := &protocol.Envelope{
		V:              1,
		Type:           protocol.FrameTypeRpcRequest,
		ID:             reqID,
		HostID:         hostID,
		SentAt:         time.Now().UTC().Format(time.RFC3339Nano),
		ExpiresAt:      expiresAt,
		IdempotencyKey: idempotencyKey,
		Payload:        json.RawMessage(`{"method":"conversation.create","params":{"projectId":"project_1","title":"Test Conversation"}}`),
	}

	if err := sendJSONEnvelope(ctx, adminWS, writeReq); err != nil {
		t.Fatalf("failed to send write rpc.request: %v", err)
	}

	// Host receives
	hostEnv, err := readJSONEnvelope(ctx, hostWS)
	if err != nil {
		t.Fatalf("host failed to read write rpc: %v", err)
	}
	if hostEnv.IdempotencyKey != idempotencyKey {
		t.Fatalf("expected idempotencyKey preserved in forwarded frame, got %s", hostEnv.IdempotencyKey)
	}

	// Host replies
	writeResp := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcResponse,
		ID:      protocol.GenerateMessageID(),
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(fmt.Sprintf(`{"requestId":%q,"ok":true,"result":{"conversationId":"c_new_123"}}`, reqID)),
	}
	if err := sendJSONEnvelope(ctx, hostWS, writeResp); err != nil {
		t.Fatalf("host failed to send write rpc.response: %v", err)
	}

	// Admin receives
	adminEnv, err := readJSONEnvelope(ctx, adminWS)
	if err != nil || adminEnv.Type != protocol.FrameTypeRpcResponse {
		t.Fatalf("admin failed to receive write rpc response: %v (err: %v)", adminEnv, err)
	}
}

func TestE2E_1000OrderedEvents(t *testing.T) {
	ts, _, _ := setupE2ETLSServer(t, func(c *config.Config) {
		c.MaxSendQueueSize = 2048 // Ensure queue fits 1000 burst events
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	hostID := testDevHostID
	hostWS := connectAndAuthHost(t, ctx, ts, hostID, testDevHostToken)
	defer hostWS.Close(websocket.StatusNormalClosure, "done")

	adminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS.Close(websocket.StatusNormalClosure, "done")

	const totalEvents = 1000
	var wg sync.WaitGroup
	wg.Add(1)

	var readErrors []error
	receivedSeqs := make([]int64, 0, totalEvents)

	// Reader goroutine for admin
	go func() {
		defer wg.Done()
		for i := 1; i <= totalEvents; i++ {
			env, err := readJSONEnvelope(ctx, adminWS)
			if err != nil {
				readErrors = append(readErrors, fmt.Errorf("read error on event %d: %w", i, err))
				return
			}
			if env.Type != protocol.FrameTypeEvent {
				readErrors = append(readErrors, fmt.Errorf("unexpected frame type on event %d: %s", i, env.Type))
				return
			}
			if env.Seq == nil {
				readErrors = append(readErrors, fmt.Errorf("missing seq on event %d", i))
				return
			}
			receivedSeqs = append(receivedSeqs, *env.Seq)
		}
	}()

	// Host streams 1000 events
	for i := 1; i <= totalEvents; i++ {
		seq := int64(i)
		eventEnv := &protocol.Envelope{
			V:       1,
			Type:    protocol.FrameTypeEvent,
			ID:      fmt.Sprintf("ev_stream_%04d", i),
			HostID:  hostID,
			Seq:     &seq,
			SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
			Payload: json.RawMessage(fmt.Sprintf(`{"name":"run.stream","data":{"runId":"run_fixture_001","item":{"kind":"text","role":"assistant","content":"chunk_%d"}}}`, i)),
		}

		if err := sendJSONEnvelope(ctx, hostWS, eventEnv); err != nil {
			t.Fatalf("host failed sending event %d: %v", i, err)
		}
	}

	wg.Wait()

	if len(readErrors) > 0 {
		t.Fatalf("encountered errors reading 1000 events: %v", readErrors[0])
	}

	if len(receivedSeqs) != totalEvents {
		t.Fatalf("expected %d events, got %d", totalEvents, len(receivedSeqs))
	}

	for i := 0; i < totalEvents; i++ {
		expectedSeq := int64(i + 1)
		if receivedSeqs[i] != expectedSeq {
			t.Fatalf("event seq mismatch at index %d: expected %d, got %d", i, expectedSeq, receivedSeqs[i])
		}
	}
}

func TestE2E_HostOffline(t *testing.T) {
	ts, _, _ := setupE2ETLSServer(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	adminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS.Close(websocket.StatusNormalClosure, "done")

	reqID := "req_offline_001"
	rpcReq := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      reqID,
		HostID:  "host_not_connected",
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"method":"conversation.list","params":{}}`),
	}

	if err := sendJSONEnvelope(ctx, adminWS, rpcReq); err != nil {
		t.Fatalf("failed to send rpc.request: %v", err)
	}

	respEnv, err := readJSONEnvelope(ctx, adminWS)
	if err != nil {
		t.Fatalf("failed to read response: %v", err)
	}
	if respEnv.Type != protocol.FrameTypeError {
		t.Fatalf("expected error frame for offline host, got %s", respEnv.Type)
	}

	var sErr protocol.StructuredError
	_ = json.Unmarshal(respEnv.Payload, &sErr)
	if sErr.Code != protocol.ErrCodeHostOffline {
		t.Fatalf("expected error code host_offline, got %s", sErr.Code)
	}
}

func TestE2E_InvalidRPCParams_NotForwarded(t *testing.T) {
	ts, _, _ := setupE2ETLSServer(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	hostWS := connectAndAuthHost(t, ctx, ts, testDevHostID, testDevHostToken)
	defer hostWS.Close(websocket.StatusNormalClosure, "done")
	adminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS.Close(websocket.StatusNormalClosure, "done")

	invalidRequest := &protocol.Envelope{
		V:       protocol.ProtocolVersion,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      "req_invalid_params_001",
		HostID:  testDevHostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"method":"conversation.get","params":{}}`),
	}
	if err := sendJSONEnvelope(ctx, adminWS, invalidRequest); err != nil {
		t.Fatalf("failed to send invalid rpc.request: %v", err)
	}

	adminReadCtx, adminReadCancel := context.WithTimeout(ctx, time.Second)
	defer adminReadCancel()
	if _, _, err := adminWS.Read(adminReadCtx); err == nil {
		t.Fatal("expected Relay to close admin connection after invalid method params")
	}

	hostReadCtx, hostReadCancel := context.WithTimeout(ctx, 150*time.Millisecond)
	defer hostReadCancel()
	if _, _, err := hostWS.Read(hostReadCtx); err == nil {
		t.Fatal("invalid rpc.request params were forwarded to host")
	}
}

func TestE2E_RPCTimeout(t *testing.T) {
	ts, srv, _ := setupE2ETLSServer(t, func(c *config.Config) {
		c.RPCTimeout = 150 * time.Millisecond
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	hostID := testDevHostID
	hostWS := connectAndAuthHost(t, ctx, ts, hostID, testDevHostToken)
	defer hostWS.Close(websocket.StatusNormalClosure, "done")

	adminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS.Close(websocket.StatusNormalClosure, "done")

	reqID := "req_timeout_test_001"
	rpcReq := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      reqID,
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"method":"conversation.list","params":{}}`),
	}

	if err := sendJSONEnvelope(ctx, adminWS, rpcReq); err != nil {
		t.Fatalf("failed to send rpc.request: %v", err)
	}

	// Host receives the request, but intentionally DOES NOT reply
	_, err := readJSONEnvelope(ctx, hostWS)
	if err != nil {
		t.Fatalf("host failed to read rpc request: %v", err)
	}

	// Admin should receive rpc_timeout error frame
	respEnv, err := readJSONEnvelope(ctx, adminWS)
	if err != nil {
		t.Fatalf("admin failed to read timeout response: %v", err)
	}
	if respEnv.Type != protocol.FrameTypeError {
		t.Fatalf("expected error frame on timeout, got %s", respEnv.Type)
	}

	var sErr protocol.StructuredError
	_ = json.Unmarshal(respEnv.Payload, &sErr)
	if sErr.Code != protocol.ErrCodeRpcTimeout {
		t.Fatalf("expected error code rpc_timeout, got %s", sErr.Code)
	}

	// Verify pending map is clean
	srv.Router().OnAdminDisconnect(nil)
}

func TestE2E_HostDisconnect_PendingCleanup(t *testing.T) {
	ts, _, _ := setupE2ETLSServer(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	hostID := testDevHostID
	hostWS := connectAndAuthHost(t, ctx, ts, hostID, testDevHostToken)

	adminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS.Close(websocket.StatusNormalClosure, "done")

	reqID := "req_host_abrupt_disc"
	rpcReq := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      reqID,
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"method":"conversation.list","params":{}}`),
	}

	if err := sendJSONEnvelope(ctx, adminWS, rpcReq); err != nil {
		t.Fatalf("failed to send rpc.request: %v", err)
	}

	// Host reads the request and immediately terminates connection without answering
	_, _ = readJSONEnvelope(ctx, hostWS)
	_ = hostWS.Close(websocket.StatusGoingAway, "crash")

	// Admin should receive host_offline error frame
	respEnv, err := readJSONEnvelope(ctx, adminWS)
	if err != nil {
		t.Fatalf("admin failed to read host_offline response: %v", err)
	}
	if respEnv.Type != protocol.FrameTypeError {
		t.Fatalf("expected error frame on host disconnect, got %s", respEnv.Type)
	}

	var sErr protocol.StructuredError
	_ = json.Unmarshal(respEnv.Payload, &sErr)
	if sErr.Code != protocol.ErrCodeHostOffline {
		t.Fatalf("expected error code host_offline, got %s", sErr.Code)
	}
}

func TestE2E_HostReplacement_AndStaleFrameDiscard(t *testing.T) {
	ts, _, _ := setupE2ETLSServer(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	hostID := testDevHostID

	// 1. Host 1 connects
	host1WS := connectAndAuthHost(t, ctx, ts, hostID, testDevHostToken)

	// 2. Host 2 connects with same hostId -> should replace Host 1
	host2WS := connectAndAuthHost(t, ctx, ts, hostID, testDevHostToken)
	defer host2WS.Close(websocket.StatusNormalClosure, "done")

	// 3. Host 1 should be closed by server
	_, err := readJSONEnvelope(ctx, host1WS)
	if err == nil {
		t.Fatal("expected host 1 to be closed after replacement")
	}

	// 4. Admin connects and sends RPC -> should reach Host 2 (new connection)
	adminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS.Close(websocket.StatusNormalClosure, "done")

	reqID := "req_replaced_host"
	rpcReq := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      reqID,
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"method":"conversation.list","params":{}}`),
	}
	if err := sendJSONEnvelope(ctx, adminWS, rpcReq); err != nil {
		t.Fatalf("failed to send rpc.request: %v", err)
	}

	host2Env, err := readJSONEnvelope(ctx, host2WS)
	if err != nil || host2Env.ID != reqID {
		t.Fatalf("expected host 2 to receive RPC, got %v (err: %v)", host2Env, err)
	}

	// 5. Host 2 responds
	rpcResp := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcResponse,
		ID:      protocol.GenerateMessageID(),
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(fmt.Sprintf(`{"requestId":%q,"ok":true,"result":{"activeHost":"host2"}}`, reqID)),
	}
	_ = sendJSONEnvelope(ctx, host2WS, rpcResp)

	adminEnv, err := readJSONEnvelope(ctx, adminWS)
	if err != nil || adminEnv.Type != protocol.FrameTypeRpcResponse {
		t.Fatalf("admin failed to get response from replaced host: %v (err: %v)", adminEnv, err)
	}
}

func TestE2E_HostReplacement_OldDisconnectCleansOnlyOldPending(t *testing.T) {
	ts, _, _ := setupE2ETLSServer(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	hostID := testDevHostID

	// 1. Host 1 connects
	host1WS := connectAndAuthHost(t, ctx, ts, hostID, testDevHostToken)

	// 2. Admin connects
	adminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS.Close(websocket.StatusNormalClosure, "done")

	// 3. Admin sends reqOld targeting host1
	reqOldID := "req_for_host1_e2e"
	rpcReqOld := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      reqOldID,
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"method":"conversation.list","params":{}}`),
	}
	if err := sendJSONEnvelope(ctx, adminWS, rpcReqOld); err != nil {
		t.Fatalf("failed to send reqOld: %v", err)
	}

	// Host 1 reads reqOld
	host1Env, err := readJSONEnvelope(ctx, host1WS)
	if err != nil || host1Env.ID != reqOldID {
		t.Fatalf("host 1 failed to read reqOld: %v", err)
	}

	// 4. Host 2 connects and replaces Host 1
	host2WS := connectAndAuthHost(t, ctx, ts, hostID, testDevHostToken)
	defer host2WS.Close(websocket.StatusNormalClosure, "done")

	// Host 1 is terminated by server
	_, err = readJSONEnvelope(ctx, host1WS)
	if err == nil {
		t.Fatal("expected host 1 to be closed after replacement")
	}

	// 5. Admin sends reqNew targeting host2
	reqNewID := "req_for_host2_e2e"
	rpcReqNew := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      reqNewID,
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"method":"conversation.get","params":{"conversationId":"c1"}}`),
	}
	if err := sendJSONEnvelope(ctx, adminWS, rpcReqNew); err != nil {
		t.Fatalf("failed to send reqNew: %v", err)
	}

	// Host 2 receives reqNew
	host2Env, err := readJSONEnvelope(ctx, host2WS)
	if err != nil || host2Env.ID != reqNewID {
		t.Fatalf("host 2 failed to read reqNew: %v", err)
	}

	// 6. Admin should receive host_offline error for reqOld (because host 1 disconnected)
	adminErrEnv, err := readJSONEnvelope(ctx, adminWS)
	if err != nil {
		t.Fatalf("admin failed to read error response for reqOld: %v", err)
	}
	if adminErrEnv.Type != protocol.FrameTypeError || adminErrEnv.ID != reqOldID {
		t.Fatalf("expected host_offline error for reqOld, got %s (id: %s)", adminErrEnv.Type, adminErrEnv.ID)
	}
	var sErr protocol.StructuredError
	_ = json.Unmarshal(adminErrEnv.Payload, &sErr)
	if sErr.Code != protocol.ErrCodeHostOffline {
		t.Fatalf("expected host_offline error code, got %s", sErr.Code)
	}

	// 7. Host 2 responds to reqNew
	rpcRespNew := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcResponse,
		ID:      protocol.GenerateMessageID(),
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(fmt.Sprintf(`{"requestId":%q,"ok":true,"result":{"success":true}}`, reqNewID)),
	}
	if err := sendJSONEnvelope(ctx, host2WS, rpcRespNew); err != nil {
		t.Fatalf("host 2 failed to send rpc.response: %v", err)
	}

	// 8. Admin receives successful rpc.response for reqNew
	adminRespEnv, err := readJSONEnvelope(ctx, adminWS)
	if err != nil {
		t.Fatalf("admin failed to read response for reqNew: %v", err)
	}
	if adminRespEnv.Type != protocol.FrameTypeRpcResponse {
		t.Fatalf("expected rpc.response for reqNew, got %s", adminRespEnv.Type)
	}
	var respPayload protocol.RpcResponsePayload
	_ = json.Unmarshal(adminRespEnv.Payload, &respPayload)
	if respPayload.RequestID != reqNewID || !respPayload.Ok {
		t.Fatalf("unexpected response payload for reqNew: %+v", respPayload)
	}
}

func TestE2E_DuplicateActiveRequestID_Rejected(t *testing.T) {
	ts, _, _ := setupE2ETLSServer(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	hostID := testDevHostID
	hostWS := connectAndAuthHost(t, ctx, ts, hostID, testDevHostToken)
	defer hostWS.Close(websocket.StatusNormalClosure, "done")

	adminWS1 := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS1.Close(websocket.StatusNormalClosure, "done")

	adminWS2 := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS2.Close(websocket.StatusNormalClosure, "done")

	reqID := "req_duplicate_test_001"
	rpcReq1 := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      reqID,
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"method":"conversation.list","params":{}}`),
	}

	// 1. Admin 1 sends request with reqID
	if err := sendJSONEnvelope(ctx, adminWS1, rpcReq1); err != nil {
		t.Fatalf("failed to send rpc.request from admin 1: %v", err)
	}

	// Host receives the request
	hostReq, err := readJSONEnvelope(ctx, hostWS)
	if err != nil || hostReq.ID != reqID {
		t.Fatalf("host failed to read first rpc request: %v", err)
	}

	// 2. Admin 2 sends request with the exact SAME reqID while first is still active
	rpcReq2 := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      reqID,
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"method":"conversation.get","params":{"conversationId":"c1"}}`),
	}
	if err := sendJSONEnvelope(ctx, adminWS2, rpcReq2); err != nil {
		t.Fatalf("failed to send rpc.request from admin 2: %v", err)
	}

	// Admin 2 should immediately receive duplicate_request error
	admin2Resp, err := readJSONEnvelope(ctx, adminWS2)
	if err != nil {
		t.Fatalf("admin 2 failed to read duplicate rejection: %v", err)
	}
	if admin2Resp.Type != protocol.FrameTypeError {
		t.Fatalf("expected error frame for duplicate request ID, got %s", admin2Resp.Type)
	}
	var sErr protocol.StructuredError
	_ = json.Unmarshal(admin2Resp.Payload, &sErr)
	if sErr.Code != protocol.ErrCodeDuplicateRequest {
		t.Fatalf("expected error code duplicate_request, got %s", sErr.Code)
	}

	// 3. Host replies to Admin 1's request
	rpcResp := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcResponse,
		ID:      protocol.GenerateMessageID(),
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(fmt.Sprintf(`{"requestId":%q,"ok":true,"result":{"conversations":[]}}`, reqID)),
	}
	_ = sendJSONEnvelope(ctx, hostWS, rpcResp)

	// Admin 1 receives the response successfully
	admin1Resp, err := readJSONEnvelope(ctx, adminWS1)
	if err != nil || admin1Resp.Type != protocol.FrameTypeRpcResponse {
		t.Fatalf("admin 1 failed to read response: %v (err: %v)", admin1Resp, err)
	}
}

func TestE2E_LateOrUnknownOrWrongHostResponse_Dropped(t *testing.T) {
	ts, _, _ := setupE2ETLSServer(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	hostID := testDevHostID
	hostWS := connectAndAuthHost(t, ctx, ts, hostID, testDevHostToken)
	defer hostWS.Close(websocket.StatusNormalClosure, "done")

	adminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS.Close(websocket.StatusNormalClosure, "done")

	// Host sends response for non-existent requestId
	orphanResp := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcResponse,
		ID:      protocol.GenerateMessageID(),
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"requestId":"req_nonexistent_999","ok":true,"result":{}}`),
	}
	if err := sendJSONEnvelope(ctx, hostWS, orphanResp); err != nil {
		t.Fatalf("failed to send orphan response: %v", err)
	}

	// Verify admin does not receive the dropped orphan response
	adminCheckCtx, adminCheckCancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer adminCheckCancel()
	if _, err := readJSONEnvelope(adminCheckCtx, adminWS); err == nil {
		t.Fatalf("expected admin not to receive dropped orphan response")
	}

	// Host sends response with illegal spoofed envelope -> strict DecodeEnvelope rejects and terminates connection (fail-closed)
	spoofedResp := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcResponse,
		ID:      protocol.GenerateMessageID(),
		HostID:  "host_spoofed_unknown",
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"requestId":"req_spoofed","ok":true}`),
	}
	_ = sendJSONEnvelope(ctx, hostWS, spoofedResp)
	_, err := readJSONEnvelope(ctx, hostWS)
	if err == nil {
		t.Fatalf("expected host connection to be disconnected on illegal spoofed envelope, got nil err")
	}
}

func TestE2E_SlowConsumer_OnlyDisconnectsSelf(t *testing.T) {
	ts, _, _ := setupE2ETLSServer(t, func(c *config.Config) {
		c.MaxSendQueueSize = 4 // Small queue to trigger backpressure quickly
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	hostID := testDevHostID
	hostWS := connectAndAuthHost(t, ctx, ts, hostID, testDevHostToken)
	defer hostWS.Close(websocket.StatusNormalClosure, "done")

	// Fast Admin: continuously reads from socket
	fastAdminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer fastAdminWS.Close(websocket.StatusNormalClosure, "done")

	// Slow Admin: does NOT read from socket after auth
	slowAdminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer slowAdminWS.Close(websocket.StatusNormalClosure, "done")

	var fastAdminReceived atomic.Int64
	var fastAdminStop atomic.Bool

	go func() {
		for !fastAdminStop.Load() {
			_, err := readJSONEnvelope(ctx, fastAdminWS)
			if err != nil {
				return
			}
			fastAdminReceived.Add(1)
		}
	}()

	// Host floods events with payload to saturate socket buffer and queue
	dataPadding := strings.Repeat("x", 4096)
	for i := 1; i <= 200; i++ {
		seq := int64(i)
		eventEnv := &protocol.Envelope{
			V:       1,
			Type:    protocol.FrameTypeEvent,
			ID:      fmt.Sprintf("ev_bp_%03d", i),
			HostID:  hostID,
			Seq:     &seq,
			SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
			Payload: json.RawMessage(fmt.Sprintf(`{"name":"terminal.output","data":{"terminalId":"term_fixture_001","data":%q,"seq":%d}}`, dataPadding, seq)),
		}
		_ = sendJSONEnvelope(ctx, hostWS, eventEnv)
	}

	time.Sleep(150 * time.Millisecond)

	// Slow admin should have been disconnected by backpressure
	var slowAdminClosed bool
	for i := 0; i < 205; i++ {
		_, err := readJSONEnvelope(ctx, slowAdminWS)
		if err != nil {
			slowAdminClosed = true
			break
		}
	}
	if !slowAdminClosed {
		t.Fatal("expected slow admin to be disconnected due to backpressure")
	}

	fastAdminStop.Store(true)

	// Fast admin must have received messages
	if fastAdminReceived.Load() == 0 {
		t.Fatal("expected fast admin to receive events normally")
	}
}

func TestE2E_ApplicationPingPong(t *testing.T) {
	ts, _, _ := setupE2ETLSServer(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	adminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS.Close(websocket.StatusNormalClosure, "done")

	// Admin sends ping
	nonce := "admin_nonce_999"
	pingEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypePing,
		ID:      protocol.GenerateMessageID(),
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(fmt.Sprintf(`{"nonce":%q}`, nonce)),
	}

	if err := sendJSONEnvelope(ctx, adminWS, pingEnv); err != nil {
		t.Fatalf("failed to send ping: %v", err)
	}

	pongEnv, err := readJSONEnvelope(ctx, adminWS)
	if err != nil {
		t.Fatalf("failed to read pong: %v", err)
	}
	if pongEnv.Type != protocol.FrameTypePong {
		t.Fatalf("expected pong frame, got %s", pongEnv.Type)
	}

	var pongPayload protocol.PongPayload
	if err := json.Unmarshal(pongEnv.Payload, &pongPayload); err != nil {
		t.Fatalf("failed to unmarshal pong payload: %v", err)
	}
	if pongPayload.Nonce != nonce {
		t.Fatalf("expected pong nonce %s, got %s", nonce, pongPayload.Nonce)
	}
	if pongPayload.ServerTime == "" {
		t.Fatal("expected serverTime in pong payload")
	}
}

func TestE2E_ServerDraining_GracefulShutdown(t *testing.T) {
	ts, srv, _ := setupE2ETLSServer(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	adminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS.Close(websocket.StatusNormalClosure, "done")

	hostWS := connectAndAuthHost(t, ctx, ts, testDevHostID, testDevHostToken)
	defer hostWS.Close(websocket.StatusNormalClosure, "done")

	// Trigger server shutdown
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer shutdownCancel()

	shutdownErrChan := make(chan error, 1)
	go func() {
		shutdownErrChan <- srv.Shutdown(shutdownCtx)
	}()

	// 1. Both Admin and Host should receive server.draining frame (Task E requirement)
	adminDrainingEnv, err := readJSONEnvelope(ctx, adminWS)
	if err != nil {
		t.Fatalf("admin failed to read draining frame: %v", err)
	}
	if adminDrainingEnv.Type != protocol.FrameTypeServerDraining {
		t.Fatalf("expected admin server.draining frame, got %s", adminDrainingEnv.Type)
	}

	hostDrainingEnv, err := readJSONEnvelope(ctx, hostWS)
	if err != nil {
		t.Fatalf("host failed to read draining frame: %v", err)
	}
	if hostDrainingEnv.Type != protocol.FrameTypeServerDraining {
		t.Fatalf("expected host server.draining frame, got %s", hostDrainingEnv.Type)
	}

	// 2. Both Admin and Host connections must be explicitly closed by server
	_, err = readJSONEnvelope(ctx, adminWS)
	if err == nil {
		t.Fatal("expected admin connection to be explicitly closed after draining")
	}

	_, err = readJSONEnvelope(ctx, hostWS)
	if err == nil {
		t.Fatal("expected host connection to be explicitly closed after draining")
	}

	if err := <-shutdownErrChan; err != nil {
		t.Fatalf("server shutdown returned error: %v", err)
	}

	// 3. Verify registry state after shutdown
	if !srv.Registry().IsDraining() {
		t.Fatal("expected registry IsDraining() to be true")
	}
	if len(srv.Registry().GetAdmins()) != 0 {
		t.Fatalf("expected 0 active admins after shutdown, got %d", len(srv.Registry().GetAdmins()))
	}
	if len(srv.Registry().GetHosts()) != 0 {
		t.Fatalf("expected 0 active hosts after shutdown, got %d", len(srv.Registry().GetHosts()))
	}

	// 4. New connection attempts should receive 503 Service Unavailable
	resp, err := ts.Client().Get(ts.URL + "/v1/ws/admin")
	if err == nil {
		_ = resp.Body.Close()
	}
}

func TestE2E_OversizedFrame_Rejected(t *testing.T) {
	ts, _, _ := setupE2ETLSServer(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	adminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS.Close(websocket.StatusNormalClosure, "done")

	// Construct oversized payload (> 256 KiB)
	largePadding := strings.Repeat("A", 300*1024)
	oversizedEnv := fmt.Sprintf(`{"v":1,"type":"ping","id":"msg_large","sentAt":%q,"payload":{"nonce":%q}}`,
		time.Now().UTC().Format(time.RFC3339Nano), largePadding)

	err := adminWS.Write(ctx, websocket.MessageText, []byte(oversizedEnv))
	if err != nil {
		return
	}

	// Reading next frame should fail because server closed the connection for oversized frame
	_, err = readJSONEnvelope(ctx, adminWS)
	if err == nil {
		t.Fatal("expected connection to be closed after oversized frame")
	}
}

func TestE2E_BinaryFrame_Rejected(t *testing.T) {
	ts, _, _ := setupE2ETLSServer(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	adminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS.Close(websocket.StatusNormalClosure, "done")

	// Send binary frame
	err := adminWS.Write(ctx, websocket.MessageBinary, []byte{0x01, 0x02, 0x03, 0x04})
	if err != nil {
		return
	}

	_, err = readJSONEnvelope(ctx, adminWS)
	if err == nil {
		t.Fatal("expected connection closed after binary frame")
	}
}

func TestE2E_ProductionFailClosed(t *testing.T) {
	// 1. Missing production secrets validation
	cfg := config.DefaultConfig()
	cfg.DevAuthMode = false // Production mode

	err := cfg.Validate()
	if err == nil {
		t.Fatal("expected production config validation to fail without secrets")
	}

	// 2. Supplying dev tokens when DevAuthMode=false must fail
	cfg.DevAuthAdminToken = "some-dev-token-with-sufficient-entropy-32"
	err = cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "must not be set when DEV_AUTH_MODE is false") {
		t.Fatalf("expected error rejecting dev tokens in production mode, got %v", err)
	}

	// 3. Live TLS Server in Production Mode rejecting Host connection fail-closed
	prodCfg := config.DefaultConfig()
	prodCfg.DevAuthMode = false
	prodCfg.WeChatAppID = "wx1234567890abcdef"
	prodCfg.WeChatAppSecret = "secret1234567890abcdef1234567890"
	prodCfg.AdminOpenID = "admin_openid_1234567890"
	prodCfg.TokenHashPepper = "pepper_with_sufficient_entropy_32_chars"

	if err := prodCfg.Validate(); err != nil {
		t.Fatalf("expected valid production config: %v", err)
	}

	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("failed to open sqlite: %v", err)
	}
	defer db.Close()

	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	srv := NewServer(prodCfg, db, logger)
	ts := httptest.NewTLSServer(srv.Handler())
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Host dials /v1/ws/host in production mode -> must receive ErrCodeUnauthorized and fail closed
	hostWS, _, err := dialWS(ctx, ts, "/v1/ws/host", nil)
	if err != nil {
		t.Fatalf("failed to dial host ws in production mode: %v", err)
	}
	defer hostWS.Close(websocket.StatusGoingAway, "done")

	errEnv, err := readJSONEnvelope(ctx, hostWS)
	if err != nil {
		t.Fatalf("expected error envelope from production host gate, got: %v", err)
	}
	if errEnv.Type != protocol.FrameTypeError {
		t.Fatalf("expected error frame type, got %s", errEnv.Type)
	}
	var sErr protocol.StructuredError
	_ = json.Unmarshal(errEnv.Payload, &sErr)
	if sErr.Code != protocol.ErrCodeUnauthorized {
		t.Fatalf("expected unauthorized error code for host in production mode, got %s", sErr.Code)
	}
}

func TestE2E_HeartbeatTimeout_DeadPeerCleanup(t *testing.T) {
	// Configure short interval and timeout for fast deterministic testing
	heartbeatInterval := 60 * time.Millisecond
	heartbeatTimeout := 25 * time.Millisecond

	ts, srv, _ := setupE2ETLSServer(t, func(c *config.Config) {
		c.HeartbeatInterval = heartbeatInterval
		c.HeartbeatTimeout = heartbeatTimeout
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	hostID := testDevHostID
	hostWS := connectAndAuthHost(t, ctx, ts, hostID, testDevHostToken)
	defer hostWS.Close(websocket.StatusGoingAway, "test_done")

	if !srv.Registry().IsHostOnline(hostID) {
		t.Fatalf("expected host %s to be online in registry", hostID)
	}

	adminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS.Close(websocket.StatusGoingAway, "test_done")

	// 1. Admin sends an RPC request to host
	reqID := "req_dead_peer_001"
	rpcReq := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeRpcRequest,
		ID:      reqID,
		HostID:  hostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"method":"conversation.list","params":{}}`),
	}
	if err := sendJSONEnvelope(ctx, adminWS, rpcReq); err != nil {
		t.Fatalf("failed to send rpc.request: %v", err)
	}

	// 2. Host reads the RPC request
	hostReceivedEnv, err := readJSONEnvelope(ctx, hostWS)
	if err != nil {
		t.Fatalf("host failed to read rpc.request: %v", err)
	}
	if hostReceivedEnv.ID != reqID {
		t.Fatalf("expected reqID %s, got %s", reqID, hostReceivedEnv.ID)
	}

	// 3. Host simulates dead peer: stops reading/responding.
	// Heartbeat watchdog should fire and notify admin with host_offline.
	adminRespEnv, err := readJSONEnvelope(ctx, adminWS)
	if err != nil {
		t.Fatalf("admin failed to read error response after host heartbeat timeout: %v", err)
	}
	if adminRespEnv.Type != protocol.FrameTypeError {
		t.Fatalf("expected error frame from relay on host disconnect, got %s", adminRespEnv.Type)
	}
	if adminRespEnv.ID != reqID {
		t.Fatalf("expected error frame for reqID %s, got %s", reqID, adminRespEnv.ID)
	}

	var sErr protocol.StructuredError
	if err := json.Unmarshal(adminRespEnv.Payload, &sErr); err != nil {
		t.Fatalf("failed to unmarshal structured error: %v", err)
	}
	if sErr.Code != protocol.ErrCodeHostOffline {
		t.Fatalf("expected error code %s, got %s", protocol.ErrCodeHostOffline, sErr.Code)
	}

	// 4. Verify host is unregistered from registry
	deadline := time.Now().Add(1 * time.Second)
	for srv.Registry().IsHostOnline(hostID) {
		if time.Now().After(deadline) {
			t.Fatalf("expected host %s to be unregistered from registry after heartbeat timeout", hostID)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// 5. Verify hostWS read fails due to server closure
	_, _, err = hostWS.Read(ctx)
	if err == nil {
		t.Fatal("expected hostWS to be closed by server on heartbeat timeout")
	}

	// 6. Verify Dead Admin peer cleanup
	adminDeadWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminDeadWS.Close(websocket.StatusGoingAway, "done")
	initialAdminCount := len(srv.Registry().GetAdmins())
	if initialAdminCount != 2 {
		t.Fatalf("expected 2 admin connections, got %d", initialAdminCount)
	}

	adminDeadline := time.Now().Add(2 * time.Second)
	for len(srv.Registry().GetAdmins()) > 1 {
		if time.Now().After(adminDeadline) {
			t.Fatalf("expected dead admin to be unregistered from registry after heartbeat timeout")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestE2E_AuthOk_ReflectsHeartbeatConfig(t *testing.T) {
	customInterval := 15 * time.Second
	customTimeout := 5 * time.Second
	ts, _, _ := setupE2ETLSServer(t, func(c *config.Config) {
		c.HeartbeatInterval = customInterval
		c.HeartbeatTimeout = customTimeout
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	adminWS, _, err := dialWS(ctx, ts, "/v1/ws/admin", nil)
	if err != nil {
		t.Fatalf("failed to dial admin ws: %v", err)
	}
	defer adminWS.Close(websocket.StatusNormalClosure, "done")

	authEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeAdminAuth,
		ID:      protocol.GenerateMessageID(),
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(fmt.Sprintf(`{"accessToken":%q,"clientVersion":"1.0.0","protocolVersion":1}`, testDevAdminToken)),
	}
	if err := sendJSONEnvelope(ctx, adminWS, authEnv); err != nil {
		t.Fatalf("failed to send admin.auth: %v", err)
	}

	resp, err := readJSONEnvelope(ctx, adminWS)
	if err != nil {
		t.Fatalf("failed to read admin auth response: %v", err)
	}
	if resp.Type != protocol.FrameTypeAuthOk {
		t.Fatalf("expected auth.ok frame, got %s", resp.Type)
	}

	var authOkPayload protocol.AuthOkPayload
	if err := json.Unmarshal(resp.Payload, &authOkPayload); err != nil {
		t.Fatalf("failed to unmarshal auth.ok payload: %v", err)
	}

	if authOkPayload.Limits.HeartbeatIntervalMs != int(customInterval.Milliseconds()) {
		t.Fatalf("expected heartbeatIntervalMs %d, got %d", int(customInterval.Milliseconds()), authOkPayload.Limits.HeartbeatIntervalMs)
	}
}

func TestE2E_AuthOk_FixedMaxFrameBytesConstant(t *testing.T) {
	// Start server with custom transport MaxFrameBytes = 65536 (64 KiB)
	customTransportMaxFrame := int64(65536)
	ts, _, _ := setupE2ETLSServer(t, func(c *config.Config) {
		c.MaxFrameBytes = customTransportMaxFrame
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// 1. Admin auth.ok limits.maxFrameBytes must be fixed constant 262144
	adminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS.Close(websocket.StatusNormalClosure, "done")

	// 2. Host auth.ok limits.maxFrameBytes must be fixed constant 262144
	hostWS := connectAndAuthHost(t, ctx, ts, testDevHostID, testDevHostToken)
	defer hostWS.Close(websocket.StatusNormalClosure, "done")

	// 3. Verify internal transport limit: frame exceeding 64 KiB is rejected by transport
	oversizedPadding := strings.Repeat("B", 70*1024)
	oversizedEnv := fmt.Sprintf(`{"v":1,"type":"ping","id":"msg_large_transport","sentAt":%q,"payload":{"nonce":%q}}`,
		time.Now().UTC().Format(time.RFC3339Nano), oversizedPadding)

	_ = adminWS.Write(ctx, websocket.MessageText, []byte(oversizedEnv))
	_, err := readJSONEnvelope(ctx, adminWS)
	if err == nil {
		t.Fatal("expected connection closed by transport for frame exceeding internal MaxFrameBytes")
	}
}

func TestE2E_Resume_Replay_And_DuplicateResume(t *testing.T) {
	ts, _, _ := setupE2ETLSServer(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	hostWS := connectAndAuthHost(t, ctx, ts, testDevHostID, testDevHostToken)
	defer hostWS.Close(websocket.StatusNormalClosure, "done")

	adminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS.Close(websocket.StatusNormalClosure, "done")

	// 1. Host sends initial event 0
	seq0 := int64(0)
	event0 := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeEvent,
		ID:      protocol.GenerateMessageID(),
		HostID:  testDevHostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Seq:     &seq0,
		Payload: json.RawMessage(`{"name":"conversation.updated","data":{"conversationId":"conv_01","title":"Test Conv","archived":false,"updatedAt":"2026-09-01T10:00:00.000Z"}}`),
	}
	if err := sendJSONEnvelope(ctx, hostWS, event0); err != nil {
		t.Fatalf("failed to send event 0: %v", err)
	}

	gotEvent0, err := readJSONEnvelope(ctx, adminWS)
	if err != nil {
		t.Fatalf("failed to read event 0 on admin: %v", err)
	}
	if gotEvent0.Type != protocol.FrameTypeEvent || gotEvent0.Seq == nil || *gotEvent0.Seq != 0 {
		t.Fatalf("expected event seq 0, got type %s, seq %v", gotEvent0.Type, gotEvent0.Seq)
	}

	// 2. Host sends event 1
	seq1 := int64(1)
	event1 := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeEvent,
		ID:      protocol.GenerateMessageID(),
		HostID:  testDevHostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Seq:     &seq1,
		Payload: json.RawMessage(`{"name":"conversation.updated","data":{"conversationId":"conv_01","title":"Updated Title","archived":false,"updatedAt":"2026-09-01T10:01:00.000Z"}}`),
	}
	if err := sendJSONEnvelope(ctx, hostWS, event1); err != nil {
		t.Fatalf("failed to send event 1: %v", err)
	}

	gotEvent1, err := readJSONEnvelope(ctx, adminWS)
	if err != nil {
		t.Fatalf("failed to read event 1 on admin: %v", err)
	}
	if gotEvent1.Type != protocol.FrameTypeEvent || gotEvent1.Seq == nil || *gotEvent1.Seq != 1 {
		t.Fatalf("expected event seq 1, got type %s, seq %v", gotEvent1.Type, gotEvent1.Seq)
	}

	// 3. Admin sends resume with resumeFrom: 0 (requesting replay of events > 0)
	resumeEnv1 := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeResume,
		ID:      "msg_resume_first",
		HostID:  testDevHostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"resumeFrom":0}`),
	}
	if err := sendJSONEnvelope(ctx, adminWS, resumeEnv1); err != nil {
		t.Fatalf("failed to send resume frame: %v", err)
	}

	// Host reads the forwarded resume frame
	hostGotResume, err := readJSONEnvelope(ctx, hostWS)
	if err != nil {
		t.Fatalf("failed to read resume frame on host: %v", err)
	}
	if hostGotResume.Type != protocol.FrameTypeResume || hostGotResume.ID != "msg_resume_first" {
		t.Fatalf("expected resume frame msg_resume_first on host, got %s / %s", hostGotResume.Type, hostGotResume.ID)
	}

	// Host replays event 1 (seq=1 <= current tail, re-using original event structure)
	if err := sendJSONEnvelope(ctx, hostWS, event1); err != nil {
		t.Fatalf("host failed to replay event 1: %v", err)
	}

	// Admin receives replayed event 1
	gotReplay1, err := readJSONEnvelope(ctx, adminWS)
	if err != nil {
		t.Fatalf("admin failed to read replayed event 1: %v", err)
	}
	if gotReplay1.Type != protocol.FrameTypeEvent || gotReplay1.Seq == nil || *gotReplay1.Seq != 1 {
		t.Fatalf("expected replayed event seq 1 on admin, got %s, seq %v", gotReplay1.Type, gotReplay1.Seq)
	}

	// 4. Admin sends duplicate resume frame (same resumeFrom: 0)
	resumeEnv2 := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeResume,
		ID:      "msg_resume_duplicate",
		HostID:  testDevHostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"resumeFrom":0}`),
	}
	if err := sendJSONEnvelope(ctx, adminWS, resumeEnv2); err != nil {
		t.Fatalf("failed to send duplicate resume frame: %v", err)
	}

	hostGotResume2, err := readJSONEnvelope(ctx, hostWS)
	if err != nil {
		t.Fatalf("failed to read duplicate resume frame on host: %v", err)
	}
	if hostGotResume2.Type != protocol.FrameTypeResume || hostGotResume2.ID != "msg_resume_duplicate" {
		t.Fatalf("expected duplicate resume frame on host, got %s / %s", hostGotResume2.Type, hostGotResume2.ID)
	}

	// Host replays event 1 again
	if err := sendJSONEnvelope(ctx, hostWS, event1); err != nil {
		t.Fatalf("host failed to send second replay: %v", err)
	}

	// Admin receives second replayed event 1 without Relay dropping it
	gotReplay2, err := readJSONEnvelope(ctx, adminWS)
	if err != nil {
		t.Fatalf("admin failed to read second replayed event 1: %v", err)
	}
	if gotReplay2.Type != protocol.FrameTypeEvent || gotReplay2.Seq == nil || *gotReplay2.Seq != 1 {
		t.Fatalf("expected second replayed event seq 1 on admin, got %s, seq %v", gotReplay2.Type, gotReplay2.Seq)
	}
}

func TestE2E_Resume_TooOldCursor_SnapshotFallback(t *testing.T) {
	ts, _, _ := setupE2ETLSServer(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	hostWS := connectAndAuthHost(t, ctx, ts, testDevHostID, testDevHostToken)
	defer hostWS.Close(websocket.StatusNormalClosure, "done")

	adminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS.Close(websocket.StatusNormalClosure, "done")

	// Admin requests resume from cursor that is too old (e.g. 999999)
	resumeEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeResume,
		ID:      "msg_resume_too_old",
		HostID:  testDevHostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"resumeFrom":999999}`),
	}
	if err := sendJSONEnvelope(ctx, adminWS, resumeEnv); err != nil {
		t.Fatalf("failed to send resume frame: %v", err)
	}

	// Host receives resume
	hostGotResume, err := readJSONEnvelope(ctx, hostWS)
	if err != nil {
		t.Fatalf("host failed to read resume frame: %v", err)
	}
	if hostGotResume.Type != protocol.FrameTypeResume {
		t.Fatalf("expected resume frame, got %s", hostGotResume.Type)
	}

	// Host sends snapshot fallback frame with valid HostStatus according to protocol v1 schema.
	seq10 := int64(10)
	snapshotEnv := &protocol.Envelope{
		V:      1,
		Type:   protocol.FrameTypeSnapshot,
		ID:     "msg_snap_fallback_01",
		HostID: testDevHostID,
		SentAt: time.Now().UTC().Format(time.RFC3339Nano),
		Seq:    &seq10,
		Payload: json.RawMessage(fmt.Sprintf(`{
			"baseSeq": 10,
			"host": {
				"hostId": %q,
				"online": true,
				"appVersion": "0.9.10",
				"protocolVersion": 1,
				"remoteEnabled": true,
				"activeRunCount": 0,
				"pendingDecisionCount": 0,
				"activeTerminalCount": 0,
				"serverTime": "2026-09-01T10:00:00.000Z"
			},
			"projects": [],
			"agents": [],
			"conversations": []
		}`, testDevHostID)),
	}

	if err := sendJSONEnvelope(ctx, hostWS, snapshotEnv); err != nil {
		t.Fatalf("host failed to send snapshot fallback: %v", err)
	}

	// Admin receives snapshot frame successfully
	adminGotSnapshot, err := readJSONEnvelope(ctx, adminWS)
	if err != nil {
		t.Fatalf("admin failed to read snapshot fallback frame: %v", err)
	}
	if adminGotSnapshot.Type != protocol.FrameTypeSnapshot {
		t.Fatalf("expected snapshot frame on admin, got %s", adminGotSnapshot.Type)
	}
	if adminGotSnapshot.Seq == nil || *adminGotSnapshot.Seq != 10 {
		t.Fatalf("expected snapshot seq 10, got %v", adminGotSnapshot.Seq)
	}

	// Subsequent live events with seq > baseSeq flow normally
	seq11 := int64(11)
	event11 := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeEvent,
		ID:      protocol.GenerateMessageID(),
		HostID:  testDevHostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Seq:     &seq11,
		Payload: json.RawMessage(`{"name":"conversation.updated","data":{"conversationId":"conv_01","title":"Post-Snapshot Title","archived":false,"updatedAt":"2026-09-01T10:05:00.000Z"}}`),
	}
	if err := sendJSONEnvelope(ctx, hostWS, event11); err != nil {
		t.Fatalf("host failed to send live event 11: %v", err)
	}

	adminGotEvent11, err := readJSONEnvelope(ctx, adminWS)
	if err != nil {
		t.Fatalf("admin failed to read event 11: %v", err)
	}
	if adminGotEvent11.Type != protocol.FrameTypeEvent || adminGotEvent11.Seq == nil || *adminGotEvent11.Seq != 11 {
		t.Fatalf("expected event seq 11, got type %s, seq %v", adminGotEvent11.Type, adminGotEvent11.Seq)
	}
}

func TestE2E_Resume_MultipleAdmins_BroadcastImpact(t *testing.T) {
	ts, _, _ := setupE2ETLSServer(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	hostWS := connectAndAuthHost(t, ctx, ts, testDevHostID, testDevHostToken)
	defer hostWS.Close(websocket.StatusNormalClosure, "done")

	// Connect two admin WebSocket clients
	admin1WS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer admin1WS.Close(websocket.StatusNormalClosure, "done")

	admin2WS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer admin2WS.Close(websocket.StatusNormalClosure, "done")

	// Host sends initial live event
	seq0 := int64(0)
	event0 := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeEvent,
		ID:      protocol.GenerateMessageID(),
		HostID:  testDevHostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Seq:     &seq0,
		Payload: json.RawMessage(`{"name":"conversation.updated","data":{"conversationId":"conv_multi","title":"Multi-Admin Event","archived":false,"updatedAt":"2026-09-01T10:00:00.000Z"}}`),
	}
	if err := sendJSONEnvelope(ctx, hostWS, event0); err != nil {
		t.Fatalf("host failed to send event 0: %v", err)
	}

	// Both admins receive event 0
	for idx, aWS := range []*websocket.Conn{admin1WS, admin2WS} {
		got, err := readJSONEnvelope(ctx, aWS)
		if err != nil {
			t.Fatalf("admin %d failed to read event 0: %v", idx+1, err)
		}
		if got.Type != protocol.FrameTypeEvent || got.Seq == nil || *got.Seq != 0 {
			t.Fatalf("admin %d expected event 0, got %s seq %v", idx+1, got.Type, got.Seq)
		}
	}

	// Admin 1 sends resume
	resumeEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeResume,
		ID:      "msg_resume_multi",
		HostID:  testDevHostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"resumeFrom":0}`),
	}
	if err := sendJSONEnvelope(ctx, admin1WS, resumeEnv); err != nil {
		t.Fatalf("admin 1 failed to send resume: %v", err)
	}

	hostGotResume, err := readJSONEnvelope(ctx, hostWS)
	if err != nil {
		t.Fatalf("host failed to read resume: %v", err)
	}
	if hostGotResume.Type != protocol.FrameTypeResume {
		t.Fatalf("expected resume on host, got %s", hostGotResume.Type)
	}

	// Host replays event 0
	if err := sendJSONEnvelope(ctx, hostWS, event0); err != nil {
		t.Fatalf("host failed to replay event 0: %v", err)
	}

	// Admin 1 (initiator) receives replayed event
	replayedAdmin1, err := readJSONEnvelope(ctx, admin1WS)
	if err != nil {
		t.Fatalf("admin 1 failed to read replayed event: %v", err)
	}
	if replayedAdmin1.Type != protocol.FrameTypeEvent || replayedAdmin1.Seq == nil || *replayedAdmin1.Seq != 0 {
		t.Fatalf("admin 1 expected replayed event seq 0, got %v", replayedAdmin1.Seq)
	}

	// Admin 2 also receives the host replayed event (as Relay routes host events to active admins)
	replayedAdmin2, err := readJSONEnvelope(ctx, admin2WS)
	if err != nil {
		t.Fatalf("admin 2 failed to read replayed event: %v", err)
	}
	if replayedAdmin2.Type != protocol.FrameTypeEvent || replayedAdmin2.Seq == nil || *replayedAdmin2.Seq != 0 {
		t.Fatalf("admin 2 expected replayed event seq 0, got %v", replayedAdmin2.Seq)
	}
}

func TestE2E_Resume_OfflineHost_ReturnsHostOffline(t *testing.T) {
	ts, _, _ := setupE2ETLSServer(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	adminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS.Close(websocket.StatusNormalClosure, "done")

	// Target host is not connected
	offlineHostID := "host_offline_target"
	resumeEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeResume,
		ID:      "msg_resume_offline",
		HostID:  offlineHostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"resumeFrom":0}`),
	}
	if err := sendJSONEnvelope(ctx, adminWS, resumeEnv); err != nil {
		t.Fatalf("failed to send resume: %v", err)
	}

	resp, err := readJSONEnvelope(ctx, adminWS)
	if err != nil {
		t.Fatalf("failed to read error response: %v", err)
	}
	if resp.Type != protocol.FrameTypeError {
		t.Fatalf("expected error frame for offline host, got %s", resp.Type)
	}
	if resp.ID != "msg_resume_offline" {
		t.Fatalf("expected matching error envelope ID msg_resume_offline, got %s", resp.ID)
	}

	var errPayload protocol.StructuredError
	if err := json.Unmarshal(resp.Payload, &errPayload); err != nil {
		t.Fatalf("failed to unmarshal error payload: %v", err)
	}
	if errPayload.Code != protocol.ErrCodeHostOffline {
		t.Fatalf("expected error code %s, got %s", protocol.ErrCodeHostOffline, errPayload.Code)
	}
}

func TestE2E_Resume_HostReplacement(t *testing.T) {
	ts, _, _ := setupE2ETLSServer(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	adminWS := connectAndAuthAdmin(t, ctx, ts, testDevAdminToken)
	defer adminWS.Close(websocket.StatusNormalClosure, "done")

	// Host 1 connects
	host1WS := connectAndAuthHost(t, ctx, ts, testDevHostID, testDevHostToken)

	// Host 2 connects with same hostId -> Host 1 must be replaced
	host2WS := connectAndAuthHost(t, ctx, ts, testDevHostID, testDevHostToken)
	defer host2WS.Close(websocket.StatusNormalClosure, "done")

	// Verify Host 1 connection is closed by replacement
	_, err := readJSONEnvelope(ctx, host1WS)
	if err == nil {
		t.Fatal("expected host 1 connection to be closed by replacement")
	}

	// Admin sends resume targeting testDevHostID
	resumeEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeResume,
		ID:      "msg_resume_after_replace",
		HostID:  testDevHostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(`{"resumeFrom":5}`),
	}
	if err := sendJSONEnvelope(ctx, adminWS, resumeEnv); err != nil {
		t.Fatalf("failed to send resume: %v", err)
	}

	// Host 2 receives the resume frame
	host2GotResume, err := readJSONEnvelope(ctx, host2WS)
	if err != nil {
		t.Fatalf("host 2 failed to read resume frame: %v", err)
	}
	if host2GotResume.Type != protocol.FrameTypeResume || host2GotResume.ID != "msg_resume_after_replace" {
		t.Fatalf("host 2 expected msg_resume_after_replace, got %s / %s", host2GotResume.Type, host2GotResume.ID)
	}

	// Host 2 replays event seq=6
	seq6 := int64(6)
	replayedEvent := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeEvent,
		ID:      "msg_event_post_replace",
		HostID:  testDevHostID,
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Seq:     &seq6,
		Payload: json.RawMessage(`{"name":"conversation.updated","data":{"conversationId":"conv_01","title":"Post-Replace Title","archived":false,"updatedAt":"2026-09-01T10:10:00.000Z"}}`),
	}
	if err := sendJSONEnvelope(ctx, host2WS, replayedEvent); err != nil {
		t.Fatalf("host 2 failed to send replayed event: %v", err)
	}

	// Admin receives replayed event
	adminGotEvent, err := readJSONEnvelope(ctx, adminWS)
	if err != nil {
		t.Fatalf("admin failed to read replayed event: %v", err)
	}
	if adminGotEvent.Type != protocol.FrameTypeEvent || adminGotEvent.Seq == nil || *adminGotEvent.Seq != 6 {
		 t.Fatalf("expected replayed event seq 6 on admin, got type %s, seq %v", adminGotEvent.Type, adminGotEvent.Seq)
	}
}
