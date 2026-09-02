package store

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// DB wraps the SQL database handle and provides SQLite lifecycle methods.
type DB struct {
	*sql.DB
	path string
}

// Open opens a SQLite database at the given path and applies safety/performance pragmas.
// Supports both in-memory databases (":memory:") and file paths.
func Open(path string) (*DB, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("sqlite path cannot be empty")
	}

	isMemory := path == ":memory:" || strings.HasPrefix(path, "file::memory:") || strings.Contains(path, "mode=memory")

	if !isMemory {
		// Ensure directory exists for file database
		dir := filepath.Dir(path)
		if dir != "." && dir != "" {
			if err := os.MkdirAll(dir, 0700); err != nil {
				return nil, fmt.Errorf("failed to create sqlite database directory %q: %w", dir, err)
			}
		}
	}

	// Connect string with SQLite parameters
	dsn := path
	if !strings.Contains(dsn, "?") {
		dsn += "?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
	}

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open sqlite database at %q: %w", path, err)
	}

	// SQLite single-writer safety
	if isMemory {
		// In-memory databases need a single connection so all queries hit the same in-memory instance
		db.SetMaxOpenConns(1)
		db.SetMaxIdleConns(1)
	} else {
		// File-based SQLite in WAL mode can have single writer connection pool
		db.SetMaxOpenConns(1)
		db.SetMaxIdleConns(1)
		db.SetConnMaxLifetime(0)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to ping sqlite database at %q: %w", path, err)
	}

	// Apply pragmas
	if !isMemory {
		if _, err := db.ExecContext(ctx, "PRAGMA journal_mode = WAL;"); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("failed to set WAL mode: %w", err)
		}
		if _, err := db.ExecContext(ctx, "PRAGMA synchronous = NORMAL;"); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("failed to set synchronous pragma: %w", err)
		}
	}

	return &DB{
		DB:   db,
		path: path,
	}, nil
}

// PingContext checks database accessibility.
func (db *DB) PingContext(ctx context.Context) error {
	if db == nil || db.DB == nil {
		return fmt.Errorf("database handle is nil")
	}
	return db.DB.PingContext(ctx)
}

// Close closes the database connection.
func (db *DB) Close() error {
	if db == nil || db.DB == nil {
		return nil
	}
	return db.DB.Close()
}

// Path returns the configured database path.
func (db *DB) Path() string {
	return db.path
}
