package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/freebuddy/freebuddy/services/remote-relay/internal/config"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/httpapi"
	"github.com/freebuddy/freebuddy/services/remote-relay/internal/store"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "relay server fatal error: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	// 1. Load and validate configuration
	cfg, err := config.LoadFromEnv()
	if err != nil {
		return fmt.Errorf("configuration error: %w", err)
	}

	// 2. Initialize structured logger
	logger := setupLogger(cfg)
	slog.SetDefault(logger)

	logger.Info("starting FreeBuddy Remote Relay server",
		slog.String("listen_addr", cfg.ListenAddr),
		slog.Bool("dev_auth_mode", cfg.DevAuthMode),
		slog.String("config", cfg.RedactedString()),
	)

	if cfg.DevAuthMode {
		logger.Warn("WARNING: DEV_AUTH_MODE is enabled. Do not use dev authentication mode in production!")
	}

	// 3. Open SQLite database and apply migrations
	logger.Info("opening sqlite database", slog.String("path", cfg.SQLitePath))
	db, err := store.Open(cfg.SQLitePath)
	if err != nil {
		return fmt.Errorf("database initialization failed: %w", err)
	}
	defer db.Close()

	migrationCtx, migrationCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer migrationCancel()

	if err := store.RunMigrations(migrationCtx, db.DB); err != nil {
		return fmt.Errorf("database migrations failed: %w", err)
	}
	logger.Info("database migrations completed successfully")

	// 4. Initialize HTTP server
	srv := httpapi.NewServer(cfg, db, logger)

	// 5. Setup graceful shutdown listener
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	serverErrChan := make(chan error, 1)
	go func() {
		serverErrChan <- srv.Start()
	}()

	// 6. Block until shutdown signal or server error
	select {
	case err := <-serverErrChan:
		if err != nil {
			return fmt.Errorf("server error: %w", err)
		}
	case <-ctx.Done():
		logger.Info("shutdown signal received, initiating graceful shutdown")
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), cfg.ShutdownGracePeriod)
		defer shutdownCancel()

		if err := srv.Shutdown(shutdownCtx); err != nil {
			logger.Error("error during server shutdown", slog.String("error", err.Error()))
		}
		logger.Info("graceful shutdown completed")
	}

	return nil
}

func setupLogger(cfg config.Config) *slog.Logger {
	var level slog.Level
	switch cfg.LogLevel {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}

	opts := &slog.HandlerOptions{
		Level: level,
	}

	var handler slog.Handler
	if cfg.LogFormat == "text" {
		handler = slog.NewTextHandler(os.Stdout, opts)
	} else {
		handler = slog.NewJSONHandler(os.Stdout, opts)
	}

	return slog.New(handler)
}
