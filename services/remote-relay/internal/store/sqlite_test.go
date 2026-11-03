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

func TestStore_PersistenceAcrossRestart(t *testing.T) {
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "persist_test.db")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// 1. Initial boot: open DB, run migrations, create an admin session record
	db1, err := Open(dbPath)
	if err != nil {
		t.Fatalf("first Open failed: %v", err)
	}

	if err := RunMigrations(ctx, db1.DB); err != nil {
		_ = db1.Close()
		t.Fatalf("RunMigrations failed: %v", err)
	}

	sessionStore1 := NewSessionStore(db1.DB)
	now := time.Now().UTC().Truncate(time.Millisecond)
	sess := &AdminSession{
		ID:               "sess_persist_123",
		TokenHash:        "thash_persist_123",
		RefreshHash:      "rhash_persist_123",
		TokenFamilyID:    "fam_persist_123",
		DeviceLabel:      "Dev Phone",
		CreatedAt:        now,
		LastUsedAt:       now,
		ExpiresAt:        now.Add(24 * time.Hour),
		RefreshExpiresAt: now.Add(7 * 24 * time.Hour),
	}
	if err := sessionStore1.CreateSession(ctx, sess); err != nil {
		_ = db1.Close()
		t.Fatalf("CreateSession failed: %v", err)
	}

	// Verify session is active before restart
	got1, err := sessionStore1.GetActiveSessionByTokenHash(ctx, "thash_persist_123")
	if err != nil {
		_ = db1.Close()
		t.Fatalf("GetActiveSessionByTokenHash before restart failed: %v", err)
	}
	if got1.ID != sess.ID {
		_ = db1.Close()
		t.Fatalf("expected session ID %q, got %q", sess.ID, got1.ID)
	}

	// 2. Simulate shutdown / restart by closing db1
	if err := db1.Close(); err != nil {
		t.Fatalf("db1.Close failed: %v", err)
	}

	// 3. Re-open database from same file path (simulating restart)
	db2, err := Open(dbPath)
	if err != nil {
		t.Fatalf("second Open failed: %v", err)
	}
	defer db2.Close()

	// Verify migrations are still applied and idempotent
	if err := RunMigrations(ctx, db2.DB); err != nil {
		t.Fatalf("second RunMigrations failed: %v", err)
	}
	migrations, err := GetAppliedMigrations(ctx, db2.DB)
	if err != nil {
		t.Fatalf("GetAppliedMigrations after restart failed: %v", err)
	}
	if len(migrations) != 1 || migrations[0].Version != 1 {
		t.Fatalf("expected 1 migration with version 1, got %+v", migrations)
	}

	// 4. Verify identity session metadata persisted across restart
	sessionStore2 := NewSessionStore(db2.DB)
	got2, err := sessionStore2.GetActiveSessionByTokenHash(ctx, "thash_persist_123")
	if err != nil {
		t.Fatalf("GetActiveSessionByTokenHash after restart failed: %v", err)
	}
	if got2.ID != sess.ID {
		t.Errorf("expected session ID %q, got %q", sess.ID, got2.ID)
	}
	if got2.TokenHash != sess.TokenHash || got2.RefreshHash != sess.RefreshHash {
		t.Errorf("token hash or refresh hash mismatch after restart")
	}
	if got2.TokenFamilyID != sess.TokenFamilyID || got2.DeviceLabel != sess.DeviceLabel {
		t.Errorf("family ID or device label mismatch after restart")
	}

	// 5. Verify touch works on persisted session after restart
	newUsedAt := now.Add(5 * time.Minute)
	if err := sessionStore2.TouchSession(ctx, got2.ID, newUsedAt); err != nil {
		t.Fatalf("TouchSession after restart failed: %v", err)
	}

	// 6. Verify all expected metadata tables exist and are queryable.
	// Note: At M2, this test specifically proves admin_sessions row-level persistence
	// and schema existence for hosts/pairings/audit_events. It does not prove row persistence
	// for hosts or pairings, which belong to M3/M4.
	for _, tbl := range []string{"admin_sessions", "hosts", "pairings", "audit_events"} {
		var count int
		if err := db2.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+tbl).Scan(&count); err != nil {
			t.Errorf("failed to query table %s after restart: %v", tbl, err)
		}
	}
}
