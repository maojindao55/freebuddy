package audit

import (
	"log/slog"
	"time"
)

// Actor types for audit events.
const (
	ActorTypeAdmin  = "admin"
	ActorTypeHost   = "host"
	ActorTypeSystem = "system"
)

// Action types for audit events.
const (
	ActionAuthAttempt       = "auth_attempt"
	ActionAuthSuccess       = "auth_success"
	ActionAuthFailure       = "auth_failure"
	ActionRpcForwarded      = "rpc_forwarded"
	ActionRpcCompleted      = "rpc_completed"
	ActionRpcTimeout        = "rpc_timeout"
	ActionRpcRejected       = "rpc_rejected"
	ActionUnmatchedResponse = "unmatched_response"
	ActionHostConnect       = "host_connect"
	ActionHostDisconnect    = "host_disconnect"
	ActionHostReplaced      = "host_replaced"
	ActionAdminConnect      = "admin_connect"
	ActionAdminDisconnect   = "admin_disconnect"
	ActionBackpressureClose = "backpressure_close"
)

// Event represents a sanitized, payload-free audit event.
type Event struct {
	Timestamp  time.Time
	ActorType  string
	ActorID    string
	Action     string
	TargetType string
	TargetID   string
	Outcome    string // "ok", "error"
	RequestID  string
	ErrorCode  string
	Duration   time.Duration
}

// Logger provides structured, metadata-only audit logging.
type Logger struct {
	logger *slog.Logger
}

// NewLogger creates a new Audit Logger.
func NewLogger(logger *slog.Logger) *Logger {
	if logger == nil {
		logger = slog.Default()
	}
	return &Logger{logger: logger}
}

// Log records an audit event with strict metadata-only attributes.
// NEVER pass message content, params, results, tokens, or credentials to this function.
func (l *Logger) Log(ev Event) {
	if ev.Timestamp.IsZero() {
		ev.Timestamp = time.Now().UTC()
	}

	attrs := []slog.Attr{
		slog.Time("audit_time", ev.Timestamp),
		slog.String("actor_type", ev.ActorType),
		slog.String("actor_id", ev.ActorID),
		slog.String("action", ev.Action),
		slog.String("target_type", ev.TargetType),
		slog.String("target_id", ev.TargetID),
		slog.String("outcome", ev.Outcome),
	}

	if ev.RequestID != "" {
		attrs = append(attrs, slog.String("request_id", ev.RequestID))
	}
	if ev.ErrorCode != "" {
		attrs = append(attrs, slog.String("error_code", ev.ErrorCode))
	}
	if ev.Duration > 0 {
		attrs = append(attrs, slog.Duration("duration", ev.Duration))
	}

	l.logger.LogAttrs(nil, slog.LevelInfo, "audit_event", attrs...)
}
