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
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/auth"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/config"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/protocol"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/store"
)

const (
	testAdminOpenID   = "wx_admin_openid_sole_admin_12345"
	testAppID         = "wx_appid_freebuddy_remote"
	testAppSecret     = "wx_secret_freebuddy_remote_xyz"
	testPepper        = "pepper_with_sufficient_length_and_entropy_123"
)

// setupFakeWeChatServer creates a mock WeChat code2Session HTTP endpoint.
func setupFakeWeChatServer(t *testing.T) *httptest.Server {
	t.Helper()

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sns/jscode2session" {
			http.NotFound(w, r)
			return
		}
		q := r.URL.Query()
		if q.Get("appid") != testAppID || q.Get("secret") != testAppSecret {
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"errcode": 40125,
				"errmsg":  "invalid appsecret",
			})
			return
		}

		code := q.Get("js_code")
		switch code {
		case "code_valid_admin":
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"openid":      testAdminOpenID,
				"session_key": "discarded_session_key",
				"errcode":     0,
			})
		case "code_non_admin_user":
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"openid":      "wx_other_user_openid_67890",
				"session_key": "discarded_session_key",
				"errcode":     0,
			})
		case "code_expired_40029":
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"errcode": 40029,
				"errmsg":  "invalid code",
			})
		case "code_ratelimit_45011":
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"errcode": 45011,
				"errmsg":  "frequency limit",
			})
		case "code_server_error":
			w.WriteHeader(http.StatusInternalServerError)
		default:
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"errcode": 40013,
				"errmsg":  "invalid appid",
			})
		}
	}))
	t.Cleanup(func() { ts.Close() })
	return ts
}

// setupAuthTLSServer sets up a test server with WeChat auth configured.
func setupAuthTLSServer(t *testing.T, wechatURL string, devAuthMode bool) (*httptest.Server, *Server, config.Config) {
	t.Helper()

	cfg := config.DefaultConfig()
	cfg.DevAuthMode = devAuthMode
	cfg.WeChatAPIBaseURL = wechatURL
	cfg.WeChatAppID = testAppID
	cfg.WeChatAppSecret = testAppSecret
	cfg.AdminOpenID = testAdminOpenID
	cfg.TokenHashPepper = testPepper
	cfg.DevAuthAdminToken = "dev-admin-token-with-sufficient-length-32"
	cfg.DevAuthHostToken = "dev-host-token-with-sufficient-length-32"
	cfg.DevAuthHostID = "host_dev"
	cfg.TokenTTL = 24 * time.Hour
	cfg.RefreshTokenTTL = 30 * 24 * time.Hour

	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("failed to open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	if err := store.RunMigrations(context.Background(), db.DB); err != nil {
		t.Fatalf("failed to run migrations: %v", err)
	}

	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	srv := NewServer(cfg, db, logger)

	ts := httptest.NewTLSServer(srv.Handler())
	t.Cleanup(func() { ts.Close() })

	return ts, srv, cfg
}

func TestHTTP_WeChatAuth_HappyPathAndSchemaCompliance(t *testing.T) {
	wechatServer := setupFakeWeChatServer(t)
	ts, srv, _ := setupAuthTLSServer(t, wechatServer.URL, false)
	client := ts.Client()

	reqBody := `{"code": "code_valid_admin", "clientVersion": "1.0.0", "deviceLabel": "iPhone 15 Pro"}`
	resp, err := client.Post(ts.URL+"/v1/auth/wechat", "application/json", strings.NewReader(reqBody))
	if err != nil {
		t.Fatalf("POST /v1/auth/wechat failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected status 200 OK, got %d: %s", resp.StatusCode, string(body))
	}

	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "application/json") {
		t.Errorf("expected application/json, got %s", ct)
	}

	var authResp protocol.WeChatAuthResponse
	if err := protocol.DecodeHTTPJSONBody(resp.Body, &authResp); err != nil {
		t.Fatalf("failed to decode WeChatAuthResponse: %v", err)
	}

	if err := authResp.Validate(); err != nil {
		t.Fatalf("authResp validation failed against schema: %v", err)
	}

	if authResp.ExpiresIn != 86400 {
		t.Errorf("expected expiresIn 86400, got %d", authResp.ExpiresIn)
	}
	if authResp.RefreshExpiresIn != 2592000 {
		t.Errorf("expected refreshExpiresIn 2592000, got %d", authResp.RefreshExpiresIn)
	}

	// Verify database: only hashed tokens, no plaintext
	ctx := context.Background()
	tokenHash := auth.HashToken(authResp.AccessToken, testPepper)
	sess, err := srv.SessionStore().GetActiveSessionByTokenHash(ctx, tokenHash)
	if err != nil {
		t.Fatalf("session not found in sqlite: %v", err)
	}
	if sess.DeviceLabel != "iPhone 15 Pro" {
		t.Errorf("expected device label 'iPhone 15 Pro', got %s", sess.DeviceLabel)
	}

	// Verify that the plaintext access token can authenticate to WebSocket /v1/ws/admin
	ws, _, err := dialWS(ctx, ts, "/v1/ws/admin", nil)
	if err != nil {
		t.Fatalf("failed to dial admin ws: %v", err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "test_done")

	authEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeAdminAuth,
		ID:      protocol.GenerateMessageID(),
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(fmt.Sprintf(`{"accessToken": %q, "clientVersion": "1.0.0", "protocolVersion": 1}`, authResp.AccessToken)),
	}
	if err := sendJSONEnvelope(ctx, ws, authEnv); err != nil {
		t.Fatalf("failed to send admin.auth envelope: %v", err)
	}

	resEnv, err := readJSONEnvelope(ctx, ws)
	if err != nil {
		t.Fatalf("failed to read envelope: %v", err)
	}
	if resEnv.Type != protocol.FrameTypeAuthOk {
		t.Fatalf("expected auth.ok frame, got %s", resEnv.Type)
	}
}

func TestHTTP_WeChatAuth_NonAdminOpenID_StrictForbidden(t *testing.T) {
	wechatServer := setupFakeWeChatServer(t)
	ts, _, _ := setupAuthTLSServer(t, wechatServer.URL, false)
	client := ts.Client()

	reqBody := `{"code": "code_non_admin_user", "clientVersion": "1.0.0"}`
	resp, err := client.Post(ts.URL+"/v1/auth/wechat", "application/json", strings.NewReader(reqBody))
	if err != nil {
		t.Fatalf("POST /v1/auth/wechat failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected status 403 Forbidden, got %d", resp.StatusCode)
	}

	var errResp protocol.StructuredError
	if err := json.NewDecoder(resp.Body).Decode(&errResp); err != nil {
		t.Fatalf("failed to decode StructuredError: %v", err)
	}

	if errResp.Code != protocol.ErrCodeForbidden {
		t.Errorf("expected error code forbidden, got %s", errResp.Code)
	}
	if errResp.Retryable {
		t.Errorf("expected retryable false for forbidden, got true")
	}

	// Ensure no OpenID was leaked in the message or details
	if strings.Contains(errResp.Message, testAdminOpenID) || strings.Contains(errResp.Message, "wx_other_user_openid_67890") {
		t.Errorf("error message leaked OpenID: %s", errResp.Message)
	}
}

func TestHTTP_WeChatAuth_WeChatErrors(t *testing.T) {
	wechatServer := setupFakeWeChatServer(t)
	ts, _, _ := setupAuthTLSServer(t, wechatServer.URL, false)
	client := ts.Client()

	tests := []struct {
		name           string
		code           string
		expectedStatus int
		expectedCode   string
	}{
		{
			name:           "expired code (40029)",
			code:           "code_expired_40029",
			expectedStatus: http.StatusUnauthorized,
			expectedCode:   protocol.ErrCodeUnauthorized,
		},
		{
			name:           "rate limit (45011)",
			code:           "code_ratelimit_45011",
			expectedStatus: http.StatusUnauthorized,
			expectedCode:   protocol.ErrCodeUnauthorized,
		},
		{
			name:           "upstream server error",
			code:           "code_server_error",
			expectedStatus: http.StatusInternalServerError,
			expectedCode:   protocol.ErrCodeInternalError,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body := fmt.Sprintf(`{"code": %q, "clientVersion": "1.0.0"}`, tt.code)
			resp, err := client.Post(ts.URL+"/v1/auth/wechat", "application/json", strings.NewReader(body))
			if err != nil {
				t.Fatalf("request failed: %v", err)
			}
			defer resp.Body.Close()

			if resp.StatusCode != tt.expectedStatus {
				t.Errorf("expected status %d, got %d", tt.expectedStatus, resp.StatusCode)
			}

			var errResp protocol.StructuredError
			if err := json.NewDecoder(resp.Body).Decode(&errResp); err != nil {
				t.Fatalf("failed to decode StructuredError: %v", err)
			}
			if errResp.Code != tt.expectedCode {
				t.Errorf("expected code %s, got %s", tt.expectedCode, errResp.Code)
			}
		})
	}
}

func TestHTTP_WeChatAuth_ValidationRejections(t *testing.T) {
	wechatServer := setupFakeWeChatServer(t)
	ts, _, _ := setupAuthTLSServer(t, wechatServer.URL, false)
	client := ts.Client()

	tests := []struct {
		name           string
		method         string
		contentType    string
		body           string
		expectedStatus int
		expectedCode   string
	}{
		{
			name:           "GET method not allowed",
			method:         http.MethodGet,
			contentType:    "application/json",
			body:           "",
			expectedStatus: http.StatusMethodNotAllowed,
			expectedCode:   protocol.ErrCodeMethodNotAllowed,
		},
		{
			name:           "wrong content-type text/plain",
			method:         http.MethodPost,
			contentType:    "text/plain",
			body:           `{"code": "abc", "clientVersion": "1.0"}`,
			expectedStatus: http.StatusBadRequest,
			expectedCode:   protocol.ErrCodeInvalidRequest,
		},
		{
			name:           "unknown property in body (additionalProperties: false)",
			method:         http.MethodPost,
			contentType:    "application/json",
			body:           `{"code": "code_valid_admin", "clientVersion": "1.0.0", "unknownField": "bad"}`,
			expectedStatus: http.StatusBadRequest,
			expectedCode:   protocol.ErrCodeInvalidRequest,
		},
		{
			name:           "missing code",
			method:         http.MethodPost,
			contentType:    "application/json",
			body:           `{"clientVersion": "1.0.0"}`,
			expectedStatus: http.StatusBadRequest,
			expectedCode:   protocol.ErrCodeInvalidRequest,
		},
		{
			name:           "code exceeds 256 bytes",
			method:         http.MethodPost,
			contentType:    "application/json",
			body:           fmt.Sprintf(`{"code": %q, "clientVersion": "1.0.0"}`, strings.Repeat("c", 257)),
			expectedStatus: http.StatusBadRequest,
			expectedCode:   protocol.ErrCodeInvalidRequest,
		},
		{
			name:           "missing clientVersion",
			method:         http.MethodPost,
			contentType:    "application/json",
			body:           `{"code": "code_valid_admin"}`,
			expectedStatus: http.StatusBadRequest,
			expectedCode:   protocol.ErrCodeInvalidRequest,
		},
		{
			name:           "trailing json data",
			method:         http.MethodPost,
			contentType:    "application/json",
			body:           `{"code": "code_valid_admin", "clientVersion": "1.0.0"} trailing`,
			expectedStatus: http.StatusBadRequest,
			expectedCode:   protocol.ErrCodeInvalidRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, err := http.NewRequest(tt.method, ts.URL+"/v1/auth/wechat", strings.NewReader(tt.body))
			if err != nil {
				t.Fatalf("failed to build request: %v", err)
			}
			if tt.contentType != "" {
				req.Header.Set("Content-Type", tt.contentType)
			}

			resp, err := client.Do(req)
			if err != nil {
				t.Fatalf("request failed: %v", err)
			}
			defer resp.Body.Close()

			if resp.StatusCode != tt.expectedStatus {
				body, _ := io.ReadAll(resp.Body)
				t.Errorf("expected status %d, got %d: %s", tt.expectedStatus, resp.StatusCode, string(body))
			}

			var errResp protocol.StructuredError
			if err := json.NewDecoder(resp.Body).Decode(&errResp); err != nil {
				t.Fatalf("failed to decode error body: %v", err)
			}
			if errResp.Code != tt.expectedCode {
				t.Errorf("expected error code %s, got %s", tt.expectedCode, errResp.Code)
			}
		})
	}
}

func TestHTTP_TokenRefresh_RotationAndReplayMitigation(t *testing.T) {
	wechatServer := setupFakeWeChatServer(t)
	ts, srv, _ := setupAuthTLSServer(t, wechatServer.URL, false)
	client := ts.Client()

	// 1. Initial login
	loginReq := `{"code": "code_valid_admin", "clientVersion": "1.0.0"}`
	resp, err := client.Post(ts.URL+"/v1/auth/wechat", "application/json", strings.NewReader(loginReq))
	if err != nil {
		t.Fatalf("login failed: %v", err)
	}
	defer resp.Body.Close()

	var authResp protocol.WeChatAuthResponse
	_ = protocol.DecodeHTTPJSONBody(resp.Body, &authResp)

	// 2. Perform valid token refresh
	refreshReq := fmt.Sprintf(`{"refreshToken": %q}`, authResp.RefreshToken)
	refreshResp, err := client.Post(ts.URL+"/v1/auth/refresh", "application/json", strings.NewReader(refreshReq))
	if err != nil {
		t.Fatalf("refresh failed: %v", err)
	}
	defer refreshResp.Body.Close()

	if refreshResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(refreshResp.Body)
		t.Fatalf("expected status 200 OK on refresh, got %d: %s", refreshResp.StatusCode, string(body))
	}

	var newTokens protocol.RefreshResponse
	_ = protocol.DecodeHTTPJSONBody(refreshResp.Body, &newTokens)
	if err := newTokens.Validate(); err != nil {
		t.Fatalf("new tokens validation failed: %v", err)
	}

	if newTokens.AccessToken == authResp.AccessToken {
		t.Errorf("expected new access token to differ from old access token")
	}
	if newTokens.RefreshToken == authResp.RefreshToken {
		t.Errorf("expected new refresh token to differ from old refresh token")
	}

	// 3. Verify old access token is revoked
	ctx := context.Background()
	oldTokenHash := auth.HashToken(authResp.AccessToken, testPepper)
	_, err = srv.SessionStore().GetActiveSessionByTokenHash(ctx, oldTokenHash)
	if err == nil {
		t.Errorf("expected old session to be inactive/revoked")
	}

	// 4. Verify new access token is active and can connect to WebSocket
	ws, _, err := dialWS(ctx, ts, "/v1/ws/admin", nil)
	if err != nil {
		t.Fatalf("dial ws failed: %v", err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "test_done")

	authEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeAdminAuth,
		ID:      protocol.GenerateMessageID(),
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(fmt.Sprintf(`{"accessToken": %q, "clientVersion": "1.0.0", "protocolVersion": 1}`, newTokens.AccessToken)),
	}
	if err := sendJSONEnvelope(ctx, ws, authEnv); err != nil {
		t.Fatalf("failed to send admin.auth: %v", err)
	}
	resEnv, err := readJSONEnvelope(ctx, ws)
	if err != nil {
		t.Fatalf("failed to read auth response: %v", err)
	}
	if resEnv.Type != protocol.FrameTypeAuthOk {
		t.Fatalf("expected auth.ok frame, got %s", resEnv.Type)
	}

	// 5. Replay attack: present the SAME old refresh token again
	replayResp, err := client.Post(ts.URL+"/v1/auth/refresh", "application/json", strings.NewReader(refreshReq))
	if err != nil {
		t.Fatalf("replay request failed: %v", err)
	}
	defer replayResp.Body.Close()

	if replayResp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected status 401 Unauthorized on replay, got %d", replayResp.StatusCode)
	}

	// 6. Verify that the ENTIRE token family is now revoked!
	newTokenHash := auth.HashToken(newTokens.AccessToken, testPepper)
	_, err = srv.SessionStore().GetActiveSessionByTokenHash(ctx, newTokenHash)
	if err == nil {
		t.Errorf("expected new access token to be revoked following replay attack")
	}
}

func TestHTTP_Logout_RevocationAndWSClosure(t *testing.T) {
	wechatServer := setupFakeWeChatServer(t)
	ts, srv, _ := setupAuthTLSServer(t, wechatServer.URL, false)
	client := ts.Client()

	// 1. Login
	loginReq := `{"code": "code_valid_admin", "clientVersion": "1.0.0"}`
	resp, err := client.Post(ts.URL+"/v1/auth/wechat", "application/json", strings.NewReader(loginReq))
	if err != nil {
		t.Fatalf("login failed: %v", err)
	}
	defer resp.Body.Close()

	var authResp protocol.WeChatAuthResponse
	_ = protocol.DecodeHTTPJSONBody(resp.Body, &authResp)

	// 2. Connect WebSocket with the access token
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	ws, _, err := dialWS(ctx, ts, "/v1/ws/admin", nil)
	if err != nil {
		t.Fatalf("dial ws failed: %v", err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "test_done")

	authEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeAdminAuth,
		ID:      protocol.GenerateMessageID(),
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(fmt.Sprintf(`{"accessToken": %q, "clientVersion": "1.0.0", "protocolVersion": 1}`, authResp.AccessToken)),
	}
	if err := sendJSONEnvelope(ctx, ws, authEnv); err != nil {
		t.Fatalf("failed to send admin.auth: %v", err)
	}
	resEnv, err := readJSONEnvelope(ctx, ws)
	if err != nil || resEnv.Type != protocol.FrameTypeAuthOk {
		t.Fatalf("expected auth.ok frame, got %v (err: %v)", resEnv, err)
	}

	// 3. Call POST /v1/sessions/logout with access token
	logoutReq, err := http.NewRequest(http.MethodPost, ts.URL+"/v1/sessions/logout", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("failed to build logout request: %v", err)
	}
	logoutReq.Header.Set("Authorization", "Bearer "+authResp.AccessToken)
	logoutReq.Header.Set("Content-Type", "application/json")

	logoutResp, err := client.Do(logoutReq)
	if err != nil {
		t.Fatalf("logout request failed: %v", err)
	}
	defer logoutResp.Body.Close()

	if logoutResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(logoutResp.Body)
		t.Fatalf("expected status 200 OK on logout, got %d: %s", logoutResp.StatusCode, string(body))
	}

	// 4. Verify WebSocket connection is closed by server
	wsReadCtx, wsReadCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer wsReadCancel()
	_, _, err = ws.Read(wsReadCtx)
	if err == nil {
		t.Errorf("expected websocket to be closed following logout, but read succeeded")
	}

	// 5. Verify database session is revoked
	tokenHash := auth.HashToken(authResp.AccessToken, testPepper)
	_, err = srv.SessionStore().GetActiveSessionByTokenHash(context.Background(), tokenHash)
	if err == nil {
		t.Errorf("expected session to be revoked in database")
	}

	// 6. Calling logout again should fail with 401 Unauthorized
	logoutReq2, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/sessions/logout", strings.NewReader("{}"))
	logoutReq2.Header.Set("Authorization", "Bearer "+authResp.AccessToken)
	logoutResp2, err := client.Do(logoutReq2)
	if err != nil {
		t.Fatalf("second logout request failed: %v", err)
	}
	defer logoutResp2.Body.Close()

	if logoutResp2.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected status 401 Unauthorized on repeated logout, got %d", logoutResp2.StatusCode)
	}
}

func TestHTTP_DevLoopbackIsolation(t *testing.T) {
	wechatServer := setupFakeWeChatServer(t)
	// Server with DEV_AUTH_MODE = true
	tsDev, _, devCfg := setupAuthTLSServer(t, wechatServer.URL, true)

	ctx := context.Background()

	// 1. Connect to dev server using DevAuthAdminToken -> succeeds via loopback
	wsDev, _, err := dialWS(ctx, tsDev, "/v1/ws/admin", nil)
	if err != nil {
		t.Fatalf("dial ws dev failed: %v", err)
	}
	defer wsDev.Close(websocket.StatusNormalClosure, "done")

	devAuthEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeAdminAuth,
		ID:      protocol.GenerateMessageID(),
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(fmt.Sprintf(`{"accessToken": %q, "clientVersion": "1.0.0", "protocolVersion": 1}`, devCfg.DevAuthAdminToken)),
	}
	if err := sendJSONEnvelope(ctx, wsDev, devAuthEnv); err != nil {
		t.Fatalf("failed to send dev admin.auth: %v", err)
	}
	resEnv, err := readJSONEnvelope(ctx, wsDev)
	if err != nil || resEnv.Type != protocol.FrameTypeAuthOk {
		t.Fatalf("expected auth.ok for dev token on dev server, got %v (err: %v)", resEnv, err)
	}

	// 2. Server with DEV_AUTH_MODE = false (Production mode)
	tsProd, _, prodCfg := setupAuthTLSServer(t, wechatServer.URL, false)

	wsProd, _, err := dialWS(ctx, tsProd, "/v1/ws/admin", nil)
	if err != nil {
		t.Fatalf("dial ws prod failed: %v", err)
	}
	defer wsProd.Close(websocket.StatusNormalClosure, "done")

	// Sending dev token to prod server -> rejected!
	prodDevAuthEnv := &protocol.Envelope{
		V:       1,
		Type:    protocol.FrameTypeAdminAuth,
		ID:      protocol.GenerateMessageID(),
		SentAt:  time.Now().UTC().Format(time.RFC3339Nano),
		Payload: json.RawMessage(fmt.Sprintf(`{"accessToken": %q, "clientVersion": "1.0.0", "protocolVersion": 1}`, prodCfg.DevAuthAdminToken)),
	}
	if err := sendJSONEnvelope(ctx, wsProd, prodDevAuthEnv); err != nil {
		t.Fatalf("failed to send admin.auth: %v", err)
	}
	errEnv, err := readJSONEnvelope(ctx, wsProd)
	if err != nil {
		t.Fatalf("failed to read envelope: %v", err)
	}
	if errEnv.Type != protocol.FrameTypeError {
		t.Fatalf("expected error frame rejecting dev token in prod, got %s", errEnv.Type)
	}
}

func TestHTTP_OversizedBodyRejection(t *testing.T) {
	wechatServer := setupFakeWeChatServer(t)
	ts, _, _ := setupAuthTLSServer(t, wechatServer.URL, false)
	client := ts.Client()

	// 300 KiB payload (exceeds 256 KiB limit)
	oversizedData := strings.Repeat("x", 300*1024)
	body := fmt.Sprintf(`{"code": %q, "clientVersion": "1.0.0"}`, oversizedData)

	resp, err := client.Post(ts.URL+"/v1/auth/wechat", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 Bad Request for oversized body, got %d", resp.StatusCode)
	}
}
