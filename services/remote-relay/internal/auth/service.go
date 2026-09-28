package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/freebuddy/freebuddy/services/remote-relay/internal/audit"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/config"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/protocol"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/store"
)

var (
	// ErrForbidden indicates access was denied because the user is not the sole admin.
	ErrForbidden = errors.New("admin authentication forbidden")
	// ErrUnauthorized indicates invalid, expired, or revoked credentials.
	ErrUnauthorized = errors.New("unauthorized")
	// ErrInvalidRequest indicates the request payload was missing or malformed.
	ErrInvalidRequest = errors.New("invalid request")
	// ErrInternal indicates an internal or upstream communication error.
	ErrInternal = errors.New("internal error")
)

// Service encapsulates the business logic for WeChat authentication, token rotation, and logout.
type Service struct {
	cfg          config.Config
	sessionStore store.SessionStore
	wechatClient *WeChatClient
	logger       *slog.Logger
	auditLogger  *audit.Logger
}

// NewService constructs an AuthService.
func NewService(cfg config.Config, sessionStore store.SessionStore, wechatClient *WeChatClient, logger *slog.Logger, auditLogger *audit.Logger) *Service {
	if logger == nil {
		logger = slog.Default()
	}
	if auditLogger == nil {
		auditLogger = audit.NewLogger(logger)
	}
	if wechatClient == nil {
		wechatClient = NewWeChatClient(WeChatClientConfig{
			BaseURL:   cfg.WeChatAPIBaseURL,
			AppID:     cfg.WeChatAppID,
			AppSecret: cfg.WeChatAppSecret,
		})
	}
	return &Service{
		cfg:          cfg,
		sessionStore: sessionStore,
		wechatClient: wechatClient,
		logger:       logger,
		auditLogger:  auditLogger,
	}
}

// SetWeChatClient allows injecting a custom WeChatClient (e.g. for testing with fake WeChat server).
func (s *Service) SetWeChatClient(client *WeChatClient) {
	s.wechatClient = client
}

// SessionStore returns the underlying session store.
func (s *Service) SessionStore() store.SessionStore {
	return s.sessionStore
}

// AuthenticateWeChat handles POST /v1/auth/wechat.
// It verifies the WeChat authorization code, enforces ADMIN_OPENID strictly,
// generates high-entropy random tokens, hashes them with pepper, and persists metadata in SQLite.
func (s *Service) AuthenticateWeChat(ctx context.Context, req *protocol.WeChatAuthRequest, remoteAddr string) (*protocol.WeChatAuthResponse, error) {
	if req == nil {
		return nil, ErrInvalidRequest
	}

	// 1. Call WeChat code2Session
	result, err := s.wechatClient.Code2Session(ctx, req.Code)
	if err != nil {
		s.logger.Warn("wechat code2session failed", slog.String("remote_addr", remoteAddr))
		s.auditLogger.Log(audit.Event{
			ActorType:  audit.ActorTypeAdmin,
			ActorID:    "anonymous",
			Action:     audit.ActionAuthFailure,
			TargetType: "relay",
			TargetID:   "wechat_code2session",
			Outcome:    "error",
			ErrorCode:  protocol.ErrCodeUnauthorized,
		})
		if errors.Is(err, ErrWeChatUpstream) {
			return nil, fmt.Errorf("%w: upstream error", ErrInternal)
		}
		return nil, ErrUnauthorized
	}

	// 2. Strict constant-time comparison with ADMIN_OPENID
	// Invariant: Do NOT log the caller's openid or the configured ADMIN_OPENID.
	if subtle.ConstantTimeCompare([]byte(result.OpenID), []byte(s.cfg.AdminOpenID)) != 1 {
		s.logger.Warn("wechat authentication forbidden: openid does not match admin",
			slog.String("remote_addr", remoteAddr),
		)
		s.auditLogger.Log(audit.Event{
			ActorType:  audit.ActorTypeAdmin,
			ActorID:    "anonymous",
			Action:     audit.ActionAuthFailure,
			TargetType: "relay",
			TargetID:   "admin_openid_check",
			Outcome:    "error",
			ErrorCode:  protocol.ErrCodeForbidden,
		})
		return nil, ErrForbidden
	}

	// 3. Generate high-entropy opaque tokens
	accessToken, err := GenerateOpaqueToken()
	if err != nil {
		return nil, fmt.Errorf("failed to generate access token: %w", err)
	}
	refreshToken, err := GenerateOpaqueToken()
	if err != nil {
		return nil, fmt.Errorf("failed to generate refresh token: %w", err)
	}

	// 4. Compute peppered hashes
	pepper := s.cfg.EffectivePepper()
	tokenHash := HashToken(accessToken, pepper)
	refreshHash := HashToken(refreshToken, pepper)

	now := time.Now().UTC()
	sessionID := protocol.GenerateMessageID()
	familyID := protocol.GenerateMessageID()

	session := &store.AdminSession{
		ID:               sessionID,
		TokenHash:        tokenHash,
		RefreshHash:      refreshHash,
		TokenFamilyID:    familyID,
		DeviceLabel:      req.DeviceLabel,
		CreatedAt:        now,
		LastUsedAt:       now,
		ExpiresAt:        now.Add(s.cfg.TokenTTL),
		RefreshExpiresAt: now.Add(s.cfg.RefreshTokenTTL),
	}

	if err := s.sessionStore.CreateSession(ctx, session); err != nil {
		return nil, fmt.Errorf("failed to persist admin session: %w", err)
	}

	s.auditLogger.Log(audit.Event{
		ActorType:  audit.ActorTypeAdmin,
		ActorID:    sessionID,
		Action:     audit.ActionAuthSuccess,
		TargetType: "relay",
		TargetID:   "wechat_session",
		Outcome:    "ok",
	})

	expiresIn := int(s.cfg.TokenTTL.Seconds())
	if expiresIn < 60 {
		expiresIn = 60
	} else if expiresIn > 86400 {
		expiresIn = 86400
	}

	refreshExpiresIn := int(s.cfg.RefreshTokenTTL.Seconds())
	if refreshExpiresIn < 60 {
		refreshExpiresIn = 60
	} else if refreshExpiresIn > 7776000 {
		refreshExpiresIn = 7776000
	}

	return &protocol.WeChatAuthResponse{
		AccessToken:      accessToken,
		RefreshToken:     refreshToken,
		ExpiresIn:        expiresIn,
		RefreshExpiresIn: refreshExpiresIn,
	}, nil
}

// RefreshToken handles POST /v1/auth/refresh.
// It rotates the access and refresh token atomically, invalidating the old session.
// If a revoked refresh token is presented, replay attack is detected and the entire family is revoked.
func (s *Service) RefreshToken(ctx context.Context, req *protocol.RefreshRequest, remoteAddr string) (*protocol.RefreshResponse, error) {
	if req == nil {
		return nil, ErrInvalidRequest
	}
	if err := protocol.ValidateOpaqueToken(req.RefreshToken); err != nil {
		return nil, ErrUnauthorized
	}

	pepper := s.cfg.EffectivePepper()
	oldRefreshHash := HashToken(req.RefreshToken, pepper)

	newAccessToken, err := GenerateOpaqueToken()
	if err != nil {
		return nil, fmt.Errorf("failed to generate access token: %w", err)
	}
	newRefreshToken, err := GenerateOpaqueToken()
	if err != nil {
		return nil, fmt.Errorf("failed to generate refresh token: %w", err)
	}

	newTokenHash := HashToken(newAccessToken, pepper)
	newRefreshHash := HashToken(newRefreshToken, pepper)

	now := time.Now().UTC()
	newSessionID := protocol.GenerateMessageID()

	newSession := &store.AdminSession{
		ID:               newSessionID,
		TokenHash:        newTokenHash,
		RefreshHash:      newRefreshHash,
		CreatedAt:        now,
		LastUsedAt:       now,
		ExpiresAt:        now.Add(s.cfg.TokenTTL),
		RefreshExpiresAt: now.Add(s.cfg.RefreshTokenTTL),
	}

	rotated, err := s.sessionStore.RotateSession(ctx, oldRefreshHash, newSession)
	if err != nil {
		s.logger.Warn("token refresh rejected",
			slog.String("remote_addr", remoteAddr),
			slog.String("error", err.Error()),
		)
		s.auditLogger.Log(audit.Event{
			ActorType:  audit.ActorTypeAdmin,
			ActorID:    "anonymous",
			Action:     audit.ActionAuthFailure,
			TargetType: "relay",
			TargetID:   "refresh_token",
			Outcome:    "error",
			ErrorCode:  protocol.ErrCodeUnauthorized,
		})
		return nil, ErrUnauthorized
	}

	s.auditLogger.Log(audit.Event{
		ActorType:  audit.ActorTypeAdmin,
		ActorID:    rotated.ID,
		Action:     "token_refresh",
		TargetType: "relay",
		TargetID:   "admin_session",
		Outcome:    "ok",
	})

	expiresIn := int(s.cfg.TokenTTL.Seconds())
	if expiresIn < 60 {
		expiresIn = 60
	} else if expiresIn > 86400 {
		expiresIn = 86400
	}

	refreshExpiresIn := int(s.cfg.RefreshTokenTTL.Seconds())
	if refreshExpiresIn < 60 {
		refreshExpiresIn = 60
	} else if refreshExpiresIn > 7776000 {
		refreshExpiresIn = 7776000
	}

	return &protocol.RefreshResponse{
		AccessToken:      newAccessToken,
		RefreshToken:     newRefreshToken,
		ExpiresIn:        expiresIn,
		RefreshExpiresIn: refreshExpiresIn,
	}, nil
}

// Logout handles POST /v1/sessions/logout.
// It revokes the current session and token family.
// Returns the revoked session ID so that any active WebSocket connections can be closed.
func (s *Service) Logout(ctx context.Context, accessToken string, remoteAddr string) (string, error) {
	if err := protocol.ValidateOpaqueToken(accessToken); err != nil {
		return "", ErrUnauthorized
	}

	pepper := s.cfg.EffectivePepper()
	tokenHash := HashToken(accessToken, pepper)

	session, err := s.sessionStore.GetActiveSessionByTokenHash(ctx, tokenHash)
	if err != nil {
		s.logger.Warn("logout rejected: session not found or expired",
			slog.String("remote_addr", remoteAddr),
		)
		return "", ErrUnauthorized
	}

	now := time.Now().UTC()
	_, err = s.sessionStore.RevokeSessionByTokenHash(ctx, tokenHash, now)
	if err != nil {
		return "", ErrUnauthorized
	}

	s.auditLogger.Log(audit.Event{
		ActorType:  audit.ActorTypeAdmin,
		ActorID:    session.ID,
		Action:     "logout",
		TargetType: "relay",
		TargetID:   "admin_session",
		Outcome:    "ok",
	})

	return session.ID, nil
}
