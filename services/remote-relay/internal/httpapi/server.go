package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/freebuddy/freebuddy/services/remote-relay/internal/config"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/store"
)

// Server encapsulates the HTTP server and API routing.
type Server struct {
	cfg        config.Config
	db         *store.DB
	logger     *slog.Logger
	httpServer *http.Server
	mux        *http.ServeMux
	handler    http.Handler
}

// NewServer creates and initializes a new HTTP API Server.
func NewServer(cfg config.Config, db *store.DB, logger *slog.Logger) *Server {
	if logger == nil {
		logger = slog.Default()
	}

	mux := http.NewServeMux()

	// Register core health endpoints
	mux.HandleFunc("/healthz", HealthzHandler())
	mux.HandleFunc("/readyz", ReadyzHandler(db))

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
		cfg:        cfg,
		db:         db,
		logger:     logger,
		httpServer: httpServer,
		mux:        mux,
		handler:    handler,
	}
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
func (s *Server) Shutdown(ctx context.Context) error {
	s.logger.Info("shutting down http server")
	return s.httpServer.Shutdown(ctx)
}
