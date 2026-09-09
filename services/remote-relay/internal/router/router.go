package router

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/freebuddy/freebuddy/services/remote-relay/internal/audit"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/config"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/protocol"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/registry"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/wsconn"
)

const maxPendingRPCs = 10000

// PendingRPC tracks an in-flight RPC request awaiting host response.
type PendingRPC struct {
	RequestID string
	AdminConn *wsconn.WSConn
	HostID    string
	HostConn  *wsconn.WSConn
	Deadline  time.Time
	CreatedAt time.Time
	Timer     *time.Timer
}

// Router handles message routing between Admin and Host connections and manages RPC correlation.
type Router struct {
	cfg         config.Config
	registry    *registry.Registry
	logger      *slog.Logger
	auditLogger *audit.Logger

	pendingMu sync.Mutex
	pending   map[string]*PendingRPC
}

// New creates a new message Router.
func New(cfg config.Config, reg *registry.Registry, logger *slog.Logger, auditLogger *audit.Logger) *Router {
	if logger == nil {
		logger = slog.Default()
	}
	if auditLogger == nil {
		auditLogger = audit.NewLogger(logger)
	}

	return &Router{
		cfg:         cfg,
		registry:    reg,
		logger:      logger,
		auditLogger: auditLogger,
		pending:     make(map[string]*PendingRPC),
	}
}

// HandleAdminFrame handles incoming protocol frames from an authenticated Admin connection.
func (r *Router) HandleAdminFrame(conn *wsconn.WSConn, env *protocol.Envelope) error {
	switch env.Type {
	case protocol.FrameTypePing:
		var p protocol.PingPayload
		_ = json.Unmarshal(env.Payload, &p)
		pong := protocol.NewPongEnvelope(protocol.GenerateConnectionID(), p.Nonce)
		return conn.SendEnvelope(pong)

	case protocol.FrameTypePong:
		return nil

	case protocol.FrameTypeRpcRequest:
		return r.handleAdminRpcRequest(conn, env)

	case protocol.FrameTypeResume:
		return r.handleAdminResume(conn, env)

	case protocol.FrameTypeError:
		r.logger.Info("admin reported protocol error", slog.String("conn_id", conn.ID()))
		return nil

	default:
		errEnv := protocol.NewErrorEnvelope(env.ID, env.HostID, protocol.ErrCodeInvalidRequest, fmt.Sprintf("unexpected frame type %q from admin", env.Type), false, nil)
		_ = conn.SendEnvelope(errEnv)
		return fmt.Errorf("unexpected frame type %q from admin", env.Type)
	}
}

func (r *Router) handleAdminRpcRequest(conn *wsconn.WSConn, env *protocol.Envelope) error {
	// 1. Validate target host ID
	if env.HostID == "" {
		errEnv := protocol.NewErrorEnvelope(env.ID, "", protocol.ErrCodeInvalidRequest, "rpc.request missing hostId", false, nil)
		_ = conn.SendEnvelope(errEnv)
		return nil
	}

	// 2. Check request expiration
	if env.ExpiresAt != "" {
		expiresAt, err := time.Parse(time.RFC3339Nano, env.ExpiresAt)
		if err == nil && time.Now().UTC().After(expiresAt) {
			r.logger.Debug("admin rpc request expired before routing",
				slog.String("request_id", env.ID),
				slog.String("host_id", env.HostID),
			)
			errEnv := protocol.NewErrorEnvelope(env.ID, env.HostID, protocol.ErrCodeRequestExpired, "request expired", false, nil)
			_ = conn.SendEnvelope(errEnv)
			return nil
		}
	}

	// 3. Check if target host is online
	hostConn, online := r.registry.GetHost(env.HostID)
	if !online {
		r.logger.Debug("target host is offline for rpc request",
			slog.String("request_id", env.ID),
			slog.String("host_id", env.HostID),
		)
		r.auditLogger.Log(audit.Event{
			ActorType:  audit.ActorTypeAdmin,
			ActorID:    conn.ID(),
			Action:     audit.ActionRpcRejected,
			TargetType: "host",
			TargetID:   env.HostID,
			Outcome:    "error",
			RequestID:  env.ID,
			ErrorCode:  protocol.ErrCodeHostOffline,
		})
		errEnv := protocol.NewErrorEnvelope(env.ID, env.HostID, protocol.ErrCodeHostOffline, "target host is offline", true, nil)
		_ = conn.SendEnvelope(errEnv)
		return nil
	}

	// 4. Calculate RPC deadline
	deadline := time.Now().Add(r.cfg.RPCTimeout)
	if env.ExpiresAt != "" {
		if exp, err := time.Parse(time.RFC3339Nano, env.ExpiresAt); err == nil && exp.Before(deadline) {
			deadline = exp
		}
	}

	timeoutDuration := time.Until(deadline)
	if timeoutDuration <= 0 {
		errEnv := protocol.NewErrorEnvelope(env.ID, env.HostID, protocol.ErrCodeRequestExpired, "request expired", false, nil)
		_ = conn.SendEnvelope(errEnv)
		return nil
	}

	// 5. Register in bounded pending RPC map
	r.pendingMu.Lock()
	if len(r.pending) >= maxPendingRPCs {
		r.pendingMu.Unlock()
		r.logger.Warn("pending rpc capacity reached, dropping request", slog.String("request_id", env.ID))
		errEnv := protocol.NewErrorEnvelope(env.ID, env.HostID, protocol.ErrCodeBackpressure, "relay rpc capacity exceeded", true, nil)
		_ = conn.SendEnvelope(errEnv)
		return nil
	}

	reqID := env.ID
	if _, exists := r.pending[reqID]; exists {
		r.pendingMu.Unlock()
		r.logger.Warn("duplicate active request ID rejected", slog.String("request_id", reqID))
		errEnv := protocol.NewErrorEnvelope(env.ID, env.HostID, protocol.ErrCodeDuplicateRequest, "duplicate active request ID", false, nil)
		_ = conn.SendEnvelope(errEnv)
		return nil
	}

	pRPC := &PendingRPC{
		RequestID: reqID,
		AdminConn: conn,
		HostID:    env.HostID,
		HostConn:  hostConn,
		Deadline:  deadline,
		CreatedAt: time.Now(),
	}

	pRPC.Timer = time.AfterFunc(timeoutDuration, func() {
		r.handleRPCTimeout(reqID)
	})

	r.pending[reqID] = pRPC
	r.pendingMu.Unlock()

	// 6. Forward envelope to host connection
	if err := hostConn.SendEnvelope(env); err != nil {
		r.pendingMu.Lock()
		if p, ok := r.pending[reqID]; ok {
			p.Timer.Stop()
			delete(r.pending, reqID)
		}
		r.pendingMu.Unlock()

		r.logger.Warn("failed to forward rpc request to host",
			slog.String("request_id", env.ID),
			slog.String("host_id", env.HostID),
			slog.String("error", err.Error()),
		)
		errEnv := protocol.NewErrorEnvelope(env.ID, env.HostID, protocol.ErrCodeHostOffline, "failed to send rpc to host", true, nil)
		_ = conn.SendEnvelope(errEnv)
		return nil
	}

	r.auditLogger.Log(audit.Event{
		ActorType:  audit.ActorTypeAdmin,
		ActorID:    conn.ID(),
		Action:     audit.ActionRpcForwarded,
		TargetType: "host",
		TargetID:   env.HostID,
		Outcome:    "ok",
		RequestID:  env.ID,
	})

	return nil
}

func (r *Router) handleAdminResume(conn *wsconn.WSConn, env *protocol.Envelope) error {
	if env.HostID == "" {
		errEnv := protocol.NewErrorEnvelope(env.ID, "", protocol.ErrCodeInvalidRequest, "resume missing hostId", false, nil)
		_ = conn.SendEnvelope(errEnv)
		return nil
	}

	hostConn, online := r.registry.GetHost(env.HostID)
	if !online {
		errEnv := protocol.NewErrorEnvelope(env.ID, env.HostID, protocol.ErrCodeHostOffline, "target host is offline", true, nil)
		_ = conn.SendEnvelope(errEnv)
		return nil
	}

	if err := hostConn.SendEnvelope(env); err != nil {
		errEnv := protocol.NewErrorEnvelope(env.ID, env.HostID, protocol.ErrCodeHostOffline, "failed to send resume to host", true, nil)
		_ = conn.SendEnvelope(errEnv)
		return nil
	}

	return nil
}

// HandleHostFrame handles incoming protocol frames from an authenticated Host connection.
func (r *Router) HandleHostFrame(conn *wsconn.WSConn, env *protocol.Envelope) error {
	// Invariant: enforce hostId matches connection-bound hostId
	if env.HostID != conn.HostID() {
		r.logger.Warn("host attempted to send frame with spoofed hostId",
			slog.String("bound_host_id", conn.HostID()),
			slog.String("envelope_host_id", env.HostID),
		)
		errEnv := protocol.NewErrorEnvelope(env.ID, conn.HostID(), protocol.ErrCodeForbidden, "hostId in envelope does not match authenticated host", false, nil)
		_ = conn.SendEnvelope(errEnv)
		return errors.New("hostId in envelope does not match authenticated host")
	}

	// Invariant: verify connection is the active host in registry.
	// Stale/replaced host connection frames must be safely discarded.
	curHost, online := r.registry.GetHost(conn.HostID())
	if !online || curHost != conn {
		r.logger.Debug("stale or unregistered host frame safely discarded",
			slog.String("host_id", conn.HostID()),
			slog.String("conn_id", conn.ID()),
			slog.String("frame_type", env.Type),
		)
		return nil
	}

	switch env.Type {
	case protocol.FrameTypePing:
		var p protocol.PingPayload
		_ = json.Unmarshal(env.Payload, &p)
		pong := protocol.NewPongEnvelope(protocol.GenerateConnectionID(), p.Nonce)
		return conn.SendEnvelope(pong)

	case protocol.FrameTypePong:
		return nil

	case protocol.FrameTypeRpcResponse:
		return r.handleHostRpcResponse(conn, env)

	case protocol.FrameTypeEvent:
		return r.handleHostEvent(conn, env)

	case protocol.FrameTypeSnapshot:
		return r.handleHostSnapshot(conn, env)

	case protocol.FrameTypeError:
		return r.handleHostError(conn, env)

	default:
		errEnv := protocol.NewErrorEnvelope(env.ID, conn.HostID(), protocol.ErrCodeInvalidRequest, fmt.Sprintf("unexpected frame type %q from host", env.Type), false, nil)
		_ = conn.SendEnvelope(errEnv)
		return fmt.Errorf("unexpected frame type %q from host", env.Type)
	}
}

func (r *Router) handleHostRpcResponse(conn *wsconn.WSConn, env *protocol.Envelope) error {
	curHost, online := r.registry.GetHost(conn.HostID())
	if !online || curHost != conn {
		r.logger.Debug("stale host rpc.response discarded",
			slog.String("host_id", conn.HostID()),
			slog.String("conn_id", conn.ID()),
		)
		return nil
	}

	var resp protocol.RpcResponsePayload
	if err := json.Unmarshal(env.Payload, &resp); err != nil {
		return fmt.Errorf("failed to unmarshal rpc.response payload: %w", err)
	}

	r.pendingMu.Lock()
	pRPC, found := r.pending[resp.RequestID]
	if !found || pRPC.HostID != conn.HostID() || (pRPC.HostConn != nil && pRPC.HostConn != conn) {
		r.pendingMu.Unlock()
		r.logger.Debug("unmatched, late, or wrong-host rpc.response from host dropped",
			slog.String("request_id", resp.RequestID),
			slog.String("host_id", conn.HostID()),
			slog.String("conn_id", conn.ID()),
		)
		r.auditLogger.Log(audit.Event{
			ActorType:  audit.ActorTypeHost,
			ActorID:    conn.ID(),
			Action:     audit.ActionUnmatchedResponse,
			TargetType: "relay",
			TargetID:   "pending_rpc",
			Outcome:    "error",
			RequestID:  resp.RequestID,
			ErrorCode:  "unmatched_response",
		})
		return nil
	}

	pRPC.Timer.Stop()
	delete(r.pending, resp.RequestID)
	r.pendingMu.Unlock()

	// Forward response strictly to originating admin connection
	duration := time.Since(pRPC.CreatedAt)
	if err := pRPC.AdminConn.SendEnvelope(env); err != nil {
		r.logger.Debug("failed to send rpc response to admin",
			slog.String("request_id", resp.RequestID),
			slog.String("error", err.Error()),
		)
	}

	r.auditLogger.Log(audit.Event{
		ActorType:  audit.ActorTypeHost,
		ActorID:    conn.ID(),
		Action:     audit.ActionRpcCompleted,
		TargetType: "admin",
		TargetID:   pRPC.AdminConn.ID(),
		Outcome:    "ok",
		RequestID:  resp.RequestID,
		Duration:   duration,
	})

	return nil
}

func (r *Router) handleHostEvent(conn *wsconn.WSConn, env *protocol.Envelope) error {
	curHost, online := r.registry.GetHost(conn.HostID())
	if !online || curHost != conn {
		r.logger.Debug("stale host event discarded",
			slog.String("host_id", conn.HostID()),
			slog.String("conn_id", conn.ID()),
		)
		return nil
	}

	admins := r.registry.GetAdmins()
	if len(admins) == 0 {
		return nil
	}

	for _, admin := range admins {
		_ = admin.SendEnvelope(env)
	}
	return nil
}

func (r *Router) handleHostSnapshot(conn *wsconn.WSConn, env *protocol.Envelope) error {
	curHost, online := r.registry.GetHost(conn.HostID())
	if !online || curHost != conn {
		r.logger.Debug("stale host snapshot discarded",
			slog.String("host_id", conn.HostID()),
			slog.String("conn_id", conn.ID()),
		)
		return nil
	}

	admins := r.registry.GetAdmins()
	for _, admin := range admins {
		_ = admin.SendEnvelope(env)
	}
	return nil
}

func (r *Router) handleHostError(conn *wsconn.WSConn, env *protocol.Envelope) error {
	curHost, online := r.registry.GetHost(conn.HostID())
	if !online || curHost != conn {
		r.logger.Debug("stale host error discarded",
			slog.String("host_id", conn.HostID()),
			slog.String("conn_id", conn.ID()),
		)
		return nil
	}

	if env.ID != "" {
		r.pendingMu.Lock()
		pRPC, found := r.pending[env.ID]
		if found && pRPC.HostID == conn.HostID() && (pRPC.HostConn == nil || pRPC.HostConn == conn) {
			pRPC.Timer.Stop()
			delete(r.pending, env.ID)
			r.pendingMu.Unlock()
			_ = pRPC.AdminConn.SendEnvelope(env)
			return nil
		}
		r.pendingMu.Unlock()
	}
	return nil
}

func (r *Router) handleRPCTimeout(reqID string) {
	r.pendingMu.Lock()
	pRPC, found := r.pending[reqID]
	if !found {
		r.pendingMu.Unlock()
		return
	}
	delete(r.pending, reqID)
	r.pendingMu.Unlock()

	r.logger.Debug("rpc timeout waiting for host response",
		slog.String("request_id", reqID),
		slog.String("host_id", pRPC.HostID),
	)

	r.auditLogger.Log(audit.Event{
		ActorType:  audit.ActorTypeSystem,
		ActorID:    "relay",
		Action:     audit.ActionRpcTimeout,
		TargetType: "admin",
		TargetID:   pRPC.AdminConn.ID(),
		Outcome:    "error",
		RequestID:  reqID,
		ErrorCode:  protocol.ErrCodeRpcTimeout,
		Duration:   time.Since(pRPC.CreatedAt),
	})

	errEnv := protocol.NewErrorEnvelope(reqID, pRPC.HostID, protocol.ErrCodeRpcTimeout, "rpc request timed out waiting for host response", true, nil)
	_ = pRPC.AdminConn.SendEnvelope(errEnv)
}

// OnHostDisconnect cleans up pending RPCs targeting this specific host connection.
func (r *Router) OnHostDisconnect(hostID string, conn *wsconn.WSConn) {
	r.pendingMu.Lock()
	defer r.pendingMu.Unlock()

	for reqID, pRPC := range r.pending {
		if pRPC.HostID == hostID && (conn == nil || pRPC.HostConn == nil || pRPC.HostConn == conn) {
			pRPC.Timer.Stop()
			delete(r.pending, reqID)

			r.logger.Debug("host disconnected; returning host_offline for pending rpc",
				slog.String("request_id", reqID),
				slog.String("host_id", hostID),
			)

			errEnv := protocol.NewErrorEnvelope(reqID, hostID, protocol.ErrCodeHostOffline, "target host disconnected", true, nil)
			_ = pRPC.AdminConn.SendEnvelope(errEnv)
		}
	}
}

// OnAdminDisconnect cleans up pending RPCs initiated by this admin connection.
func (r *Router) OnAdminDisconnect(conn *wsconn.WSConn) {
	r.pendingMu.Lock()
	defer r.pendingMu.Unlock()

	for reqID, pRPC := range r.pending {
		if pRPC.AdminConn == conn {
			pRPC.Timer.Stop()
			delete(r.pending, reqID)
		}
	}
}
