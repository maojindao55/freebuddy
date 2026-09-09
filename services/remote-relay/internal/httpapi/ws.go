package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/audit"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/config"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/protocol"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/registry"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/router"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/wsconn"
)

const defaultAuthTimeout = 5 * time.Second

// AdminWSHandler handles WebSocket connections from the Admin client (/v1/ws/admin).
func AdminWSHandler(rtr *router.Router, reg *registry.Registry, cfg config.Config, logger *slog.Logger, auditLogger *audit.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if reg.IsDraining() {
			http.Error(w, "Server is draining", http.StatusServiceUnavailable)
			return
		}

		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			InsecureSkipVerify: true,
		})
		if err != nil {
			logger.Warn("admin websocket upgrade failed", slog.String("error", err.Error()))
			return
		}

		conn := wsconn.NewWSConn(ws, wsconn.Config{
			MaxFrameBytes:    cfg.MaxFrameBytes,
			MaxSendQueueSize: cfg.MaxSendQueueSize,
			WriteTimeout:     cfg.HTTPWriteTimeout,
			Logger:           logger,
			RemoteAddr:       r.RemoteAddr,
		})
		defer conn.Close(websocket.StatusNormalClosure, "handler_exit")

		// 1. Authenticate Admin within timeout
		authCtx, authCancel := context.WithTimeout(conn.Context(), defaultAuthTimeout)
		defer authCancel()

		var accessToken string

		// Check handshake headers for dev token if dev mode is enabled
		if cfg.DevAuthMode {
			authHeader := r.Header.Get("Authorization")
			if strings.HasPrefix(authHeader, "Bearer ") {
				accessToken = strings.TrimPrefix(authHeader, "Bearer ")
			} else if devToken := r.Header.Get("X-Dev-Admin-Token"); devToken != "" {
				accessToken = devToken
			}
		}

		// If no header token or header token did not match, read admin.auth frame
		if accessToken == "" || (cfg.DevAuthMode && accessToken != cfg.DevAuthAdminToken) {
			env, err := conn.ReadEnvelope(authCtx)
			if err != nil {
				logger.Debug("failed to read admin.auth envelope", slog.String("error", err.Error()))
				errEnv := protocol.NewErrorEnvelope(protocol.GenerateConnectionID(), "", protocol.ErrCodeUnauthorized, "authentication timeout or invalid frame", false, nil)
				_ = conn.SendEnvelopeSync(authCtx, errEnv)
				return
			}

			if env.Type != protocol.FrameTypeAdminAuth {
				errEnv := protocol.NewErrorEnvelope(env.ID, "", protocol.ErrCodeUnauthorized, "first frame must be admin.auth", false, nil)
				_ = conn.SendEnvelopeSync(authCtx, errEnv)
				return
			}

			var p protocol.AdminAuthPayload
			if err := json.Unmarshal(env.Payload, &p); err != nil {
				errEnv := protocol.NewErrorEnvelope(env.ID, "", protocol.ErrCodeUnauthorized, "invalid admin.auth payload", false, nil)
				_ = conn.SendEnvelopeSync(authCtx, errEnv)
				return
			}
			accessToken = p.AccessToken
		}

		// Verify token
		authenticated := false
		if cfg.DevAuthMode {
			if accessToken == cfg.DevAuthAdminToken {
				authenticated = true
			}
		}

		if !authenticated {
			logger.Warn("admin authentication failed: invalid credentials", slog.String("conn_id", conn.ID()))
			auditLogger.Log(audit.Event{
				ActorType:  audit.ActorTypeAdmin,
				ActorID:    conn.ID(),
				Action:     audit.ActionAuthFailure,
				TargetType: "relay",
				TargetID:   "admin_auth",
				Outcome:    "error",
				ErrorCode:  protocol.ErrCodeUnauthorized,
			})
			errEnv := protocol.NewErrorEnvelope(protocol.GenerateConnectionID(), "", protocol.ErrCodeUnauthorized, "invalid admin token", false, nil)
			_ = conn.SendEnvelopeSync(authCtx, errEnv)
			return
		}

		// Authentication successful
		conn.SetRole(protocol.RoleAdmin)
		conn.SetAdminID("admin_primary")

		limits := protocol.NewConnectionLimits(cfg.HeartbeatInterval, cfg.ChallengeTTL, cfg.RPCTimeout)

		authOk := protocol.NewAuthOkEnvelope(
			protocol.GenerateConnectionID(),
			conn.ID(),
			protocol.RoleAdmin,
			"",
			limits,
		)
		if err := conn.SendEnvelope(authOk); err != nil {
			return
		}

		conn.StartHeartbeat(cfg.HeartbeatInterval, cfg.HeartbeatTimeout)

		reg.RegisterAdmin(conn)
		defer func() {
			reg.UnregisterAdmin(conn)
			rtr.OnAdminDisconnect(conn)
		}()

		auditLogger.Log(audit.Event{
			ActorType:  audit.ActorTypeAdmin,
			ActorID:    conn.ID(),
			Action:     audit.ActionAuthSuccess,
			TargetType: "relay",
			TargetID:   "admin_session",
			Outcome:    "ok",
		})

		// 2. Main Reader Loop
		for {
			env, err := conn.ReadEnvelope(conn.Context())
			if err != nil {
				if !errors.Is(err, context.Canceled) && !errors.Is(err, wsconn.ErrClosed) {
					logger.Debug("admin connection read ended", slog.String("conn_id", conn.ID()), slog.String("error", err.Error()))
				}
				break
			}

			if err := rtr.HandleAdminFrame(conn, env); err != nil {
				logger.Debug("error handling admin frame", slog.String("conn_id", conn.ID()), slog.String("error", err.Error()))
			}
		}
	}
}

// HostWSHandler handles WebSocket connections from FreeBuddy Desktop Host (/v1/ws/host).
func HostWSHandler(rtr *router.Router, reg *registry.Registry, cfg config.Config, logger *slog.Logger, auditLogger *audit.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if reg.IsDraining() {
			http.Error(w, "Server is draining", http.StatusServiceUnavailable)
			return
		}

		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			InsecureSkipVerify: true,
		})
		if err != nil {
			logger.Warn("host websocket upgrade failed", slog.String("error", err.Error()))
			return
		}

		conn := wsconn.NewWSConn(ws, wsconn.Config{
			MaxFrameBytes:    cfg.MaxFrameBytes,
			MaxSendQueueSize: cfg.MaxSendQueueSize,
			WriteTimeout:     cfg.HTTPWriteTimeout,
			Logger:           logger,
			RemoteAddr:       r.RemoteAddr,
		})
		defer conn.Close(websocket.StatusNormalClosure, "handler_exit")

		authCtx, authCancel := context.WithTimeout(conn.Context(), defaultAuthTimeout)
		defer authCancel()

		// In M1, only DEV_AUTH_MODE with a valid temporary host token handshake is allowed.
		// Production challenge-response and unauthorized DEV attempts must fail-closed.
		if !cfg.DevAuthMode || cfg.DevAuthHostToken == "" {
			logger.Warn("host connection rejected: challenge/signature auth not available in M1; DEV_AUTH_MODE required",
				slog.String("conn_id", conn.ID()),
			)
			auditLogger.Log(audit.Event{
				ActorType:  audit.ActorTypeHost,
				ActorID:    conn.ID(),
				Action:     audit.ActionAuthFailure,
				TargetType: "relay",
				TargetID:   "host_auth",
				Outcome:    "error",
				ErrorCode:  protocol.ErrCodeUnauthorized,
			})
			errEnv := protocol.NewErrorEnvelope(protocol.GenerateConnectionID(), "", protocol.ErrCodeUnauthorized, "host token required in dev mode; live pairing disabled in M1", false, nil)
			_ = conn.SendEnvelopeSync(authCtx, errEnv)
			return
		}

		// Read token from handshake headers
		authHeader := r.Header.Get("Authorization")
		var tokenProvided string
		if strings.HasPrefix(authHeader, "Bearer ") {
			tokenProvided = strings.TrimPrefix(authHeader, "Bearer ")
		} else if devToken := r.Header.Get("X-Dev-Host-Token"); devToken != "" {
			tokenProvided = devToken
		}

		if tokenProvided != cfg.DevAuthHostToken {
			logger.Warn("host authentication failed: invalid or missing host token",
				slog.String("conn_id", conn.ID()),
			)
			auditLogger.Log(audit.Event{
				ActorType:  audit.ActorTypeHost,
				ActorID:    conn.ID(),
				Action:     audit.ActionAuthFailure,
				TargetType: "relay",
				TargetID:   "host_auth",
				Outcome:    "error",
				ErrorCode:  protocol.ErrCodeUnauthorized,
			})
			errEnv := protocol.NewErrorEnvelope(protocol.GenerateConnectionID(), "", protocol.ErrCodeUnauthorized, "invalid host token", false, nil)
			_ = conn.SendEnvelopeSync(authCtx, errEnv)
			return
		}

		// Enforce stable host identity bound to DevAuthHostID.
		// Refuse mismatched or custom self-reported hostId.
		hdrHostID := r.Header.Get("X-Host-Id")
		queryHostID := r.URL.Query().Get("host_id")
		if (hdrHostID != "" && hdrHostID != cfg.DevAuthHostID) || (queryHostID != "" && queryHostID != cfg.DevAuthHostID) {
			reported := hdrHostID
			if reported == "" {
				reported = queryHostID
			}
			logger.Warn("host authentication failed: mismatched self-reported hostId",
				slog.String("conn_id", conn.ID()),
				slog.String("expected_host_id", cfg.DevAuthHostID),
				slog.String("reported_host_id", reported),
			)
			auditLogger.Log(audit.Event{
				ActorType:  audit.ActorTypeHost,
				ActorID:    conn.ID(),
				Action:     audit.ActionAuthFailure,
				TargetType: "host",
				TargetID:   reported,
				Outcome:    "error",
				ErrorCode:  protocol.ErrCodeUnauthorized,
			})
			errEnv := protocol.NewErrorEnvelope(protocol.GenerateConnectionID(), reported, protocol.ErrCodeUnauthorized, "mismatched host identity", false, nil)
			_ = conn.SendEnvelopeSync(authCtx, errEnv)
			return
		}

		hostID := cfg.DevAuthHostID
		conn.SetRole(protocol.RoleHost)
		conn.SetHostID(hostID)

		limits := protocol.NewConnectionLimits(cfg.HeartbeatInterval, cfg.ChallengeTTL, cfg.RPCTimeout)

		authOk := protocol.NewAuthOkEnvelope(
			protocol.GenerateConnectionID(),
			conn.ID(),
			protocol.RoleHost,
			hostID,
			limits,
		)
		if err := conn.SendEnvelope(authOk); err != nil {
			return
		}

		conn.StartHeartbeat(cfg.HeartbeatInterval, cfg.HeartbeatTimeout)

		// Register host (and replace older connection if any)
		oldConn := reg.RegisterHost(hostID, conn)
		if oldConn != nil {
			oldConn.Close(websocket.StatusPolicyViolation, "replaced_by_new_connection")
		}

		defer func() {
			reg.UnregisterHost(hostID, conn)
			rtr.OnHostDisconnect(hostID, conn)
		}()

		auditLogger.Log(audit.Event{
			ActorType:  audit.ActorTypeHost,
			ActorID:    conn.ID(),
			Action:     audit.ActionAuthSuccess,
			TargetType: "host",
			TargetID:   hostID,
			Outcome:    "ok",
		})

		// Main Reader Loop
		for {
			env, err := conn.ReadEnvelope(conn.Context())
			if err != nil {
				if !errors.Is(err, context.Canceled) && !errors.Is(err, wsconn.ErrClosed) {
					logger.Debug("host connection read ended", slog.String("host_id", hostID), slog.String("error", err.Error()))
				}
				break
			}

			if err := rtr.HandleHostFrame(conn, env); err != nil {
				logger.Debug("error handling host frame", slog.String("host_id", hostID), slog.String("error", err.Error()))
			}
		}
	}
}
