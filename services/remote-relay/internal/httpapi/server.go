package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/freebuddy/freebuddy/services/remote-relay/internal/audit"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/auth"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/config"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/protocol"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/registry"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/router"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/store"
)

// Server encapsulates the HTTP server and API routing.
type Server struct {
	cfg          config.Config
	db           *store.DB
	logger       *slog.Logger
	auditLogger  *audit.Logger
	registry     *registry.Registry
	router       *router.Router
	sessionStore store.SessionStore
	authService  *auth.Service
	httpServer   *http.Server
	mux          *http.ServeMux
	handler      http.Handler
}

// NewServer creates and initializes a new HTTP API Server.
func NewServer(cfg config.Config, db *store.DB, logger *slog.Logger) *Server {
	if logger == nil {
		logger = slog.Default()
	}

	auditLogger := audit.NewLogger(logger)
	reg := registry.New(logger, auditLogger)
	rtr := router.New(cfg, reg, logger, auditLogger)

	var sessionStore store.SessionStore
	if db != nil && db.DB != nil {
		sessionStore = store.NewSessionStore(db.DB)
	}
	authService := auth.NewService(cfg, sessionStore, nil, logger, auditLogger)

	mux := http.NewServeMux()

	// Register core health endpoints
	mux.HandleFunc("/healthz", HealthzHandler())
	mux.HandleFunc("/readyz", ReadyzHandler(db))

	// Register HTTP Auth endpoints (protocol/remote/v1/http.schema.json)
	mux.HandleFunc("/v1/auth/wechat", WeChatAuthHandler(authService, cfg, logger, auditLogger))
	mux.HandleFunc("/v1/auth/refresh", RefreshAuthHandler(authService, cfg, logger, auditLogger))
	mux.HandleFunc("/v1/sessions/logout", LogoutHandler(authService, reg, cfg, logger, auditLogger))

	// Register WebSocket endpoints
	mux.HandleFunc("/v1/ws/admin", AdminWSHandler(rtr, reg, sessionStore, cfg, logger, auditLogger))
	mux.HandleFunc("/v1/ws/host", HostWSHandler(rtr, reg, cfg, logger, auditLogger))

	// Compose middleware chain
	var handler http.Handler = mux
	handler = RequestLogger(logger)(handler)
	handler = Recovery(logger)(handler)
	handler = SecurityHeaders(handler)

	httpServer := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           handler,
		ReadHeaderTimeout: cfg.HTTPReadHeaderTimeout,
		ReadTimeout:       cfg.HTTPReadTimeout,
		WriteTimeout:      cfg.HTTPWriteTimeout,
		IdleTimeout:       cfg.HTTPIdleTimeout,
		MaxHeaderBytes:    1 << 20, // 1 MiB max headers
	}

	return &Server{
		cfg:          cfg,
		db:           db,
		logger:       logger,
		auditLogger:  auditLogger,
		registry:     reg,
		router:       rtr,
		sessionStore: sessionStore,
		authService:  authService,
		httpServer:   httpServer,
		mux:          mux,
		handler:      handler,
	}
}

// AuthService returns the authentication service.
func (s *Server) AuthService() *auth.Service {
	return s.authService
}

// SessionStore returns the session store.
func (s *Server) SessionStore() store.SessionStore {
	return s.sessionStore
}

// SetWeChatClient allows injecting a custom WeChatClient (e.g. for testing with fake WeChat server).
func (s *Server) SetWeChatClient(client *auth.WeChatClient) {
	if s.authService != nil {
		s.authService.SetWeChatClient(client)
	}
}

// Registry returns the connection registry.
func (s *Server) Registry() *registry.Registry {
	return s.registry
}

// Router returns the message router.
func (s *Server) Router() *router.Router {
	return s.router
}

// Handler returns the root HTTP handler for testing.
func (s *Server) Handler() http.Handler {
	return s.handler
}

// Start runs the HTTP server and blocks until it is shut down or an error occurs.
func (s *Server) Start() error {
	s.logger.Info("starting http server", slog.String("addr", s.cfg.ListenAddr))
	if err := s.httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("http server failed: %w", err)
	}
	return nil
}

// Shutdown gracefully stops the HTTP server.
// It notifies active WebSocket connections with server.draining, closes them, and shuts down HTTP.
func (s *Server) Shutdown(ctx context.Context) error {
	s.logger.Info("initiating graceful shutdown: sending server.draining to all connections")

	// 1. Mark server as draining
	s.registry.SetDraining(true)

	// 2. Broadcast server.draining frame to all active admin and host connections
	drainingEnv := protocol.NewServerDrainingEnvelope(protocol.GenerateConnectionID(), "shutdown", 1000)
	for _, admin := range s.registry.GetAdmins() {
		_ = admin.SendEnvelope(drainingEnv)
	}
	for _, host := range s.registry.GetHosts() {
		_ = host.SendEnvelope(drainingEnv)
	}

	// 3. Allow a brief moment for pending writes to flush
	select {
	case <-time.After(50 * time.Millisecond):
	case <-ctx.Done():
	}

	// 4. Explicitly close all active upgraded WebSocket connections
	s.registry.CloseAll("server_draining")

	// 5. Shutdown underlying HTTP server
	return s.httpServer.Shutdown(ctx)
}
