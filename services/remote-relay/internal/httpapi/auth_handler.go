package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"

	"github.com/freebuddy/freebuddy/services/remote-relay/internal/audit"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/auth"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/config"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/protocol"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/registry"
)

// writeStructuredError writes a structured JSON error response conforming to protocol/remote/v1 errors.json.
func writeStructuredError(w http.ResponseWriter, httpStatus int, code string, msg string, retryable bool) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(httpStatus)
	_ = json.NewEncoder(w).Encode(protocol.StructuredError{
		Code:      code,
		Message:   msg,
		Retryable: retryable,
	})
}

func checkContentTypeJSON(r *http.Request) bool {
	ct := r.Header.Get("Content-Type")
	if ct == "" {
		return false
	}
	mediaType, _, err := mime.ParseMediaType(ct)
	return err == nil && mediaType == "application/json"
}

// WeChatAuthHandler handles POST /v1/auth/wechat.
func WeChatAuthHandler(authService *auth.Service, cfg config.Config, logger *slog.Logger, auditLogger *audit.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			writeStructuredError(w, http.StatusMethodNotAllowed, protocol.ErrCodeMethodNotAllowed, "method not allowed: must be POST", false)
			return
		}

		if !checkContentTypeJSON(r) {
			writeStructuredError(w, http.StatusBadRequest, protocol.ErrCodeInvalidRequest, "Content-Type must be application/json", false)
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, protocol.MaxAllowedFrameBytes)

		var req protocol.WeChatAuthRequest
		if err := protocol.DecodeHTTPJSONBody(r.Body, &req); err != nil {
			writeStructuredError(w, http.StatusBadRequest, protocol.ErrCodeInvalidRequest, "invalid json body or unknown fields", false)
			return
		}

		if err := req.Validate(); err != nil {
			writeStructuredError(w, http.StatusBadRequest, protocol.ErrCodeInvalidRequest, err.Error(), false)
			return
		}

		resp, err := authService.AuthenticateWeChat(r.Context(), &req, r.RemoteAddr)
		if err != nil {
			if errors.Is(err, auth.ErrForbidden) {
				writeStructuredError(w, http.StatusForbidden, protocol.ErrCodeForbidden, "admin authentication forbidden", false)
				return
			}
			if errors.Is(err, auth.ErrInternal) {
				writeStructuredError(w, http.StatusInternalServerError, protocol.ErrCodeInternalError, "wechat upstream service error", true)
				return
			}
			if errors.Is(err, auth.ErrUnauthorized) {
				writeStructuredError(w, http.StatusUnauthorized, protocol.ErrCodeUnauthorized, "wechat authentication failed", false)
				return
			}
			writeStructuredError(w, http.StatusInternalServerError, protocol.ErrCodeInternalError, "internal server error", true)
			return
		}

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(resp)
	}
}

// RefreshAuthHandler handles POST /v1/auth/refresh.
func RefreshAuthHandler(authService *auth.Service, cfg config.Config, logger *slog.Logger, auditLogger *audit.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			writeStructuredError(w, http.StatusMethodNotAllowed, protocol.ErrCodeMethodNotAllowed, "method not allowed: must be POST", false)
			return
		}

		if !checkContentTypeJSON(r) {
			writeStructuredError(w, http.StatusBadRequest, protocol.ErrCodeInvalidRequest, "Content-Type must be application/json", false)
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, protocol.MaxAllowedFrameBytes)

		var req protocol.RefreshRequest
		if err := protocol.DecodeHTTPJSONBody(r.Body, &req); err != nil {
			writeStructuredError(w, http.StatusBadRequest, protocol.ErrCodeInvalidRequest, "invalid json body or unknown fields", false)
			return
		}

		if err := req.Validate(); err != nil {
			writeStructuredError(w, http.StatusBadRequest, protocol.ErrCodeInvalidRequest, err.Error(), false)
			return
		}

		resp, err := authService.RefreshToken(r.Context(), &req, r.RemoteAddr)
		if err != nil {
			writeStructuredError(w, http.StatusUnauthorized, protocol.ErrCodeUnauthorized, "invalid or expired refresh token", false)
			return
		}

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(resp)
	}
}

// LogoutHandler handles POST /v1/sessions/logout.
func LogoutHandler(authService *auth.Service, reg *registry.Registry, cfg config.Config, logger *slog.Logger, auditLogger *audit.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			writeStructuredError(w, http.StatusMethodNotAllowed, protocol.ErrCodeMethodNotAllowed, "method not allowed: must be POST", false)
			return
		}

		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			writeStructuredError(w, http.StatusUnauthorized, protocol.ErrCodeUnauthorized, "missing or invalid authorization header", false)
			return
		}
		token := strings.TrimPrefix(authHeader, "Bearer ")
		if err := protocol.ValidateOpaqueToken(token); err != nil {
			writeStructuredError(w, http.StatusUnauthorized, protocol.ErrCodeUnauthorized, "invalid access token", false)
			return
		}

		// Strictly validate body: if present and non-empty, must match empty object {}
		r.Body = http.MaxBytesReader(w, r.Body, protocol.MaxAllowedFrameBytes)
		var bodyBytes [1]byte
		n, _ := io.ReadFull(r.Body, bodyBytes[:])
		if n > 0 {
			var req protocol.LogoutRequest
			combined := io.MultiReader(strings.NewReader(string(bodyBytes[:n])), r.Body)
			if err := protocol.DecodeHTTPJSONBody(combined, &req); err != nil {
				writeStructuredError(w, http.StatusBadRequest, protocol.ErrCodeInvalidRequest, "invalid json body or unknown fields", false)
				return
			}
		}

		sessionID, err := authService.Logout(r.Context(), token, r.RemoteAddr)
		if err != nil {
			writeStructuredError(w, http.StatusUnauthorized, protocol.ErrCodeUnauthorized, "invalid or already revoked session", false)
			return
		}

		if reg != nil && sessionID != "" {
			reg.CloseAdminSession(sessionID, "logout")
		}

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}\n"))
	}
}
