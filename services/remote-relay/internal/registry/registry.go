package registry

import (
	"log/slog"
	"sync"
	"sync/atomic"

	"github.com/coder/websocket"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/audit"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/wsconn"
)

// Registry manages thread-safe tracking of online host and admin connections.
type Registry struct {
	mu          sync.RWMutex
	hosts       map[string]*wsconn.WSConn // hostId -> WSConn
	admins      map[string]*wsconn.WSConn // connId -> WSConn
	draining    atomic.Bool
	logger      *slog.Logger
	auditLogger *audit.Logger
}

// New creates a new Connection Registry.
func New(logger *slog.Logger, auditLogger *audit.Logger) *Registry {
	if logger == nil {
		logger = slog.Default()
	}
	if auditLogger == nil {
		auditLogger = audit.NewLogger(logger)
	}
	return &Registry{
		hosts:       make(map[string]*wsconn.WSConn),
		admins:      make(map[string]*wsconn.WSConn),
		logger:      logger,
		auditLogger: auditLogger,
	}
}

// RegisterHost registers an authenticated host connection.
// If an older connection for this hostId is already active, it is replaced and returned
// so that the caller can deterministically close the old connection.
func (r *Registry) RegisterHost(hostID string, conn *wsconn.WSConn) (oldConn *wsconn.WSConn) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if existing, found := r.hosts[hostID]; found {
		oldConn = existing
		r.logger.Info("replacing existing host connection with new connection",
			slog.String("host_id", hostID),
			slog.String("old_conn_id", existing.ID()),
			slog.String("new_conn_id", conn.ID()),
		)
		r.auditLogger.Log(audit.Event{
			ActorType:  audit.ActorTypeHost,
			ActorID:    conn.ID(),
			Action:     audit.ActionHostReplaced,
			TargetType: "host",
			TargetID:   hostID,
			Outcome:    "ok",
		})
	}

	r.hosts[hostID] = conn
	r.auditLogger.Log(audit.Event{
		ActorType:  audit.ActorTypeHost,
		ActorID:    conn.ID(),
		Action:     audit.ActionHostConnect,
		TargetType: "host",
		TargetID:   hostID,
		Outcome:    "ok",
	})
	return oldConn
}

// UnregisterHost removes a host connection if it is currently registered.
// If a newer connection has already replaced it, this returns false and does nothing.
func (r *Registry) UnregisterHost(hostID string, conn *wsconn.WSConn) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	if current, found := r.hosts[hostID]; found && current == conn {
		delete(r.hosts, hostID)
		r.logger.Info("host connection unregistered",
			slog.String("host_id", hostID),
			slog.String("conn_id", conn.ID()),
		)
		r.auditLogger.Log(audit.Event{
			ActorType:  audit.ActorTypeHost,
			ActorID:    conn.ID(),
			Action:     audit.ActionHostDisconnect,
			TargetType: "host",
			TargetID:   hostID,
			Outcome:    "ok",
		})
		return true
	}
	return false
}

// GetHost returns the active connection for a host ID, if online.
func (r *Registry) GetHost(hostID string) (*wsconn.WSConn, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	conn, found := r.hosts[hostID]
	return conn, found
}

// IsHostOnline returns true if the host is currently registered and connected.
func (r *Registry) IsHostOnline(hostID string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()

	_, found := r.hosts[hostID]
	return found
}

// RegisterAdmin registers an authenticated admin connection.
func (r *Registry) RegisterAdmin(conn *wsconn.WSConn) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.admins[conn.ID()] = conn
	r.logger.Info("admin connection registered", slog.String("conn_id", conn.ID()))
	r.auditLogger.Log(audit.Event{
		ActorType:  audit.ActorTypeAdmin,
		ActorID:    conn.ID(),
		Action:     audit.ActionAdminConnect,
		TargetType: "relay",
		TargetID:   "admin_session",
		Outcome:    "ok",
	})
}

// UnregisterAdmin removes an admin connection.
func (r *Registry) UnregisterAdmin(conn *wsconn.WSConn) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, found := r.admins[conn.ID()]; found {
		delete(r.admins, conn.ID())
		r.logger.Info("admin connection unregistered", slog.String("conn_id", conn.ID()))
		r.auditLogger.Log(audit.Event{
			ActorType:  audit.ActorTypeAdmin,
			ActorID:    conn.ID(),
			Action:     audit.ActionAdminDisconnect,
			TargetType: "relay",
			TargetID:   "admin_session",
			Outcome:    "ok",
		})
		return true
	}
	return false
}

// GetAdmins returns a snapshot list of all currently active admin connections.
func (r *Registry) GetAdmins() []*wsconn.WSConn {
	r.mu.RLock()
	defer r.mu.RUnlock()

	list := make([]*wsconn.WSConn, 0, len(r.admins))
	for _, c := range r.admins {
		list = append(list, c)
	}
	return list
}

// GetHosts returns a snapshot list of all currently active host connections.
func (r *Registry) GetHosts() []*wsconn.WSConn {
	r.mu.RLock()
	defer r.mu.RUnlock()

	list := make([]*wsconn.WSConn, 0, len(r.hosts))
	for _, c := range r.hosts {
		list = append(list, c)
	}
	return list
}

// SetDraining marks the registry as entering draining / shutdown state.
func (r *Registry) SetDraining(draining bool) {
	r.draining.Store(draining)
}

// IsDraining returns true if server is draining connections.
func (r *Registry) IsDraining() bool {
	return r.draining.Load()
}

// CloseAll closes all registered host and admin connections cleanly.
func (r *Registry) CloseAll(reason string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for hostID, conn := range r.hosts {
		conn.Close(websocket.StatusGoingAway, reason)
		delete(r.hosts, hostID)
	}

	for id, conn := range r.admins {
		conn.Close(websocket.StatusGoingAway, reason)
		delete(r.admins, id)
	}
}
