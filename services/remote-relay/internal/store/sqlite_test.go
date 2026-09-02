package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestOpen_Memory(t *testing.T) {
	db, err := Open(":memory:")
	if err != nil {
		t.Fatalf("failed to open in-memory db: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("failed to ping in-memory db: %v", err)
	}
}

func TestOpen_File(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "relay-store-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	dbPath := filepath.Join(tmpDir, "sub", "test_relay.db")
	db, err := Open(dbPath)
	if err != nil {
		t.Fatalf("failed to open file db: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("failed to ping file db: %v", err)
	}

	// Verify journal mode is WAL
	var journalMode string
	err = db.QueryRowContext(ctx, "PRAGMA journal_mode;").Scan(&journalMode)
	if err != nil {
		t.Fatalf("failed to query journal_mode: %v", err)
	}
	if journalMode != "wal" {
		t.Errorf("expected journal_mode wal, got %s", journalMode)
	}

	// Verify foreign keys are enabled
	var foreignKeys int
	err = db.QueryRowContext(ctx, "PRAGMA foreign_keys;").Scan(&foreignKeys)
	if err != nil {
		t.Fatalf("failed to query foreign_keys: %v", err)
	}
	if foreignKeys != 1 {
		t.Errorf("expected foreign_keys 1, got %d", foreignKeys)
	}
}

func TestOpen_EmptyPath(t *testing.T) {
	_, err := Open("")
	if err == nil {
		t.Fatal("expected error for empty sqlite path, got nil")
	}
}
