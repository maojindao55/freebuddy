package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/freebuddy/freebuddy/services/remote-relay/internal/config"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/protocol"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/store"
)

func setupTestAuthService(t *testing.T, adminOpenID string, wechatHandler http.HandlerFunc) (*Service, store.SessionStore, *httptest.Server) {
	t.Helper()

	ts := httptest.NewServer(wechatHandler)
	t.Cleanup(func() { ts.Close() })

	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("failed to open memory db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := store.RunMigrations(ctx, db.DB); err != nil {
		t.Fatalf("failed to run migrations: %v", err)
	}

	sessionStore := store.NewSessionStore(db.DB)

	cfg := config.DefaultConfig()
	cfg.WeChatAppID = "test_appid"
	cfg.WeChatAppSecret = "test_appsecret"
	cfg.AdminOpenID = adminOpenID
	cfg.TokenHashPepper = "test_pepper_with_sufficient_length_123"
	cfg.TokenTTL = 24 * time.Hour
	cfg.RefreshTokenTTL = 30 * 24 * time.Hour

	wechatClient := NewWeChatClient(WeChatClientConfig{
		BaseURL:    ts.URL,
		AppID:      cfg.WeChatAppID,
		AppSecret:  cfg.WeChatAppSecret,
		HTTPClient: ts.Client(),
	})

	srv := NewService(cfg, sessionStore, wechatClient, nil, nil)
	return srv, sessionStore, ts
}

func TestAuthService_AuthenticateWeChat_AdminMatch(t *testing.T) {
	adminOpenID := "admin_real_openid_12345"

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"openid":      adminOpenID,
			"session_key": "discard_key",
			"errcode":     0,
		})
	})

	svc, sStore, _ := setupTestAuthService(t, adminOpenID, handler)
	ctx := context.Background()

	req := &protocol.WeChatAuthRequest{
		Code:          "valid_code",
		ClientVersion: "1.0.0",
		DeviceLabel:   "iPhone 15",
	}

	resp, err := svc.AuthenticateWeChat(ctx, req, "127.0.0.1")
	if err != nil {
		t.Fatalf("AuthenticateWeChat failed: %v", err)
	}

	if err := resp.Validate(); err != nil {
		t.Errorf("response validation failed: %v", err)
	}

	// Verify session in DB
	pepper := "test_pepper_with_sufficient_length_123"
	tokenHash := HashToken(resp.AccessToken, pepper)
	sess, err := sStore.GetActiveSessionByTokenHash(ctx, tokenHash)
	if err != nil {
		t.Fatalf("session not found in DB: %v", err)
	}
	if sess.DeviceLabel != "iPhone 15" {
		t.Errorf("expected DeviceLabel 'iPhone 15', got %s", sess.DeviceLabel)
	}
}

func TestAuthService_AuthenticateWeChat_ForbiddenMismatch(t *testing.T) {
	adminOpenID := "admin_real_openid_12345"
	attackerOpenID := "attacker_openid_99999"

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"openid":      attackerOpenID,
			"session_key": "discard_key",
			"errcode":     0,
		})
	})

	svc, _, _ := setupTestAuthService(t, adminOpenID, handler)
	ctx := context.Background()

	req := &protocol.WeChatAuthRequest{
		Code:          "attacker_code",
		ClientVersion: "1.0.0",
	}

	_, err := svc.AuthenticateWeChat(ctx, req, "127.0.0.1")
	if !errors.Is(err, ErrForbidden) {
		t.Errorf("expected ErrForbidden for non-admin openid, got %v", err)
	}
}

func TestAuthService_RefreshAndReplayDetection(t *testing.T) {
	adminOpenID := "admin_openid_12345"

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"openid":      adminOpenID,
			"session_key": "discard_key",
			"errcode":     0,
		})
	})

	svc, sStore, _ := setupTestAuthService(t, adminOpenID, handler)
	ctx := context.Background()

	// 1. Initial login
	authResp, err := svc.AuthenticateWeChat(ctx, &protocol.WeChatAuthRequest{
		Code:          "initial_code",
		ClientVersion: "1.0.0",
	}, "127.0.0.1")
	if err != nil {
		t.Fatalf("AuthenticateWeChat failed: %v", err)
	}

	// 2. Refresh token rotation
	refreshReq := &protocol.RefreshRequest{
		RefreshToken: authResp.RefreshToken,
	}
	refResp1, err := svc.RefreshToken(ctx, refreshReq, "127.0.0.1")
	if err != nil {
		t.Fatalf("first RefreshToken failed: %v", err)
	}
	if err := refResp1.Validate(); err != nil {
		t.Errorf("refResp1 validation failed: %v", err)
	}

	// Verify old access token is revoked
	pepper := "test_pepper_with_sufficient_length_123"
	oldTokenHash := HashToken(authResp.AccessToken, pepper)
	_, err = sStore.GetActiveSessionByTokenHash(ctx, oldTokenHash)
	if !errors.Is(err, store.ErrSessionRevoked) {
		t.Errorf("expected old access token to be revoked, got %v", err)
	}

	// Verify new access token is active
	newTokenHash := HashToken(refResp1.AccessToken, pepper)
	_, err = sStore.GetActiveSessionByTokenHash(ctx, newTokenHash)
	if err != nil {
		t.Errorf("expected new access token to be active, got %v", err)
	}

	// 3. Replay attack: present the same old refresh token again!
	_, err = svc.RefreshToken(ctx, refreshReq, "127.0.0.1")
	if !errors.Is(err, ErrUnauthorized) {
		t.Errorf("expected ErrUnauthorized on replay attack, got %v", err)
	}

	// 4. Verify family revocation: even the newly issued access token must now be revoked!
	_, err = sStore.GetActiveSessionByTokenHash(ctx, newTokenHash)
	if !errors.Is(err, store.ErrSessionRevoked) {
		t.Errorf("expected entire family to be revoked following replay attack, got %v", err)
	}
}

func TestAuthService_Logout(t *testing.T) {
	adminOpenID := "admin_openid_12345"

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"openid":      adminOpenID,
			"session_key": "discard_key",
			"errcode":     0,
		})
	})

	svc, sStore, _ := setupTestAuthService(t, adminOpenID, handler)
	ctx := context.Background()

	authResp, err := svc.AuthenticateWeChat(ctx, &protocol.WeChatAuthRequest{
		Code:          "initial_code",
		ClientVersion: "1.0.0",
	}, "127.0.0.1")
	if err != nil {
		t.Fatalf("AuthenticateWeChat failed: %v", err)
	}

	// Logout
	sessID, err := svc.Logout(ctx, authResp.AccessToken, "127.0.0.1")
	if err != nil {
		t.Fatalf("Logout failed: %v", err)
	}
	if sessID == "" {
		t.Errorf("expected non-empty session ID from logout")
	}

	// Access token should now be revoked
	pepper := "test_pepper_with_sufficient_length_123"
	tokenHash := HashToken(authResp.AccessToken, pepper)
	_, err = sStore.GetActiveSessionByTokenHash(ctx, tokenHash)
	if !errors.Is(err, store.ErrSessionRevoked) {
		t.Errorf("expected session to be revoked after logout, got %v", err)
	}

	// Second logout should fail with ErrUnauthorized
	_, err = svc.Logout(ctx, authResp.AccessToken, "127.0.0.1")
	if !errors.Is(err, ErrUnauthorized) {
		t.Errorf("expected ErrUnauthorized on second logout, got %v", err)
	}
}
