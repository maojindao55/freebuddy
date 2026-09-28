package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func setupTestDB(t *testing.T) (*DB, SessionStore) {
	t.Helper()
	db, err := Open(":memory:")
	if err != nil {
		t.Fatalf("failed to open memory db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := RunMigrations(ctx, db.DB); err != nil {
		t.Fatalf("failed to run migrations: %v", err)
	}

	store := NewSessionStore(db.DB)
	return db, store
}

func TestSessionStore_CreateAndGet(t *testing.T) {
	_, s := setupTestDB(t)
	ctx := context.Background()
	now := time.Now().UTC()

	sess := &AdminSession{
		ID:               "sess_001",
		TokenHash:        "thash_001",
		RefreshHash:      "rhash_001",
		TokenFamilyID:    "fam_001",
		DeviceLabel:      "Test Phone",
		CreatedAt:        now,
		LastUsedAt:       now,
		ExpiresAt:        now.Add(1 * time.Hour),
		RefreshExpiresAt: now.Add(24 * time.Hour),
	}

	if err := s.CreateSession(ctx, sess); err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	retrieved, err := s.GetActiveSessionByTokenHash(ctx, "thash_001")
	if err != nil {
		t.Fatalf("GetActiveSessionByTokenHash failed: %v", err)
	}
	if retrieved.ID != "sess_001" {
		t.Errorf("expected ID sess_001, got %s", retrieved.ID)
	}
	if retrieved.DeviceLabel != "Test Phone" {
		t.Errorf("expected DeviceLabel 'Test Phone', got %s", retrieved.DeviceLabel)
	}
}

func TestSessionStore_ExpiredSession(t *testing.T) {
	_, s := setupTestDB(t)
	ctx := context.Background()
	now := time.Now().UTC()

	sess := &AdminSession{
		ID:               "sess_expired",
		TokenHash:        "thash_expired",
		RefreshHash:      "rhash_expired",
		TokenFamilyID:    "fam_002",
		CreatedAt:        now.Add(-2 * time.Hour),
		LastUsedAt:       now.Add(-2 * time.Hour),
		ExpiresAt:        now.Add(-1 * time.Hour), // Expired!
		RefreshExpiresAt: now.Add(24 * time.Hour),
	}

	if err := s.CreateSession(ctx, sess); err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	_, err := s.GetActiveSessionByTokenHash(ctx, "thash_expired")
	if !errors.Is(err, ErrSessionExpired) {
		t.Errorf("expected ErrSessionExpired, got %v", err)
	}
}

func TestSessionStore_RotateSession_Success(t *testing.T) {
	_, s := setupTestDB(t)
	ctx := context.Background()
	now := time.Now().UTC()

	orig := &AdminSession{
		ID:               "sess_orig",
		TokenHash:        "thash_orig",
		RefreshHash:      "rhash_orig",
		TokenFamilyID:    "fam_rotate",
		DeviceLabel:      "Desktop",
		CreatedAt:        now,
		LastUsedAt:       now,
		ExpiresAt:        now.Add(1 * time.Hour),
		RefreshExpiresAt: now.Add(24 * time.Hour),
	}
	if err := s.CreateSession(ctx, orig); err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	newSess := &AdminSession{
		ID:               "sess_new",
		TokenHash:        "thash_new",
		RefreshHash:      "rhash_new",
		CreatedAt:        now,
		LastUsedAt:       now,
		ExpiresAt:        now.Add(1 * time.Hour),
		RefreshExpiresAt: now.Add(24 * time.Hour),
	}

	rotated, err := s.RotateSession(ctx, "rhash_orig", newSess)
	if err != nil {
		t.Fatalf("RotateSession failed: %v", err)
	}
	if rotated.TokenFamilyID != "fam_rotate" {
		t.Errorf("expected family ID to be inherited, got %s", rotated.TokenFamilyID)
	}
	if rotated.DeviceLabel != "Desktop" {
		t.Errorf("expected device label to be inherited, got %s", rotated.DeviceLabel)
	}

	// Old session token should now be revoked
	_, err = s.GetActiveSessionByTokenHash(ctx, "thash_orig")
	if !errors.Is(err, ErrSessionRevoked) {
		t.Errorf("expected old session to be revoked, got %v", err)
	}

	// New session token should be active
	retrievedNew, err := s.GetActiveSessionByTokenHash(ctx, "thash_new")
	if err != nil {
		t.Fatalf("expected new session to be active, got %v", err)
	}
	if retrievedNew.ID != "sess_new" {
		t.Errorf("expected ID sess_new, got %s", retrievedNew.ID)
	}
}

func TestSessionStore_RotateSession_ReplayAttack(t *testing.T) {
	_, s := setupTestDB(t)
	ctx := context.Background()
	now := time.Now().UTC()

	orig := &AdminSession{
		ID:               "sess_orig",
		TokenHash:        "thash_orig",
		RefreshHash:      "rhash_orig",
		TokenFamilyID:    "fam_replay",
		CreatedAt:        now,
		LastUsedAt:       now,
		ExpiresAt:        now.Add(1 * time.Hour),
		RefreshExpiresAt: now.Add(24 * time.Hour),
	}
	if err := s.CreateSession(ctx, orig); err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	// First rotation: valid
	newSess1 := &AdminSession{
		ID:               "sess_new_1",
		TokenHash:        "thash_new_1",
		RefreshHash:      "rhash_new_1",
		CreatedAt:        now,
		LastUsedAt:       now,
		ExpiresAt:        now.Add(1 * time.Hour),
		RefreshExpiresAt: now.Add(24 * time.Hour),
	}
	_, err := s.RotateSession(ctx, "rhash_orig", newSess1)
	if err != nil {
		t.Fatalf("First rotation failed: %v", err)
	}

	// Second rotation using the SAME old refresh token: REPLAY ATTACK!
	newSess2 := &AdminSession{
		ID:               "sess_new_2",
		TokenHash:        "thash_new_2",
		RefreshHash:      "rhash_new_2",
		CreatedAt:        now,
		LastUsedAt:       now,
		ExpiresAt:        now.Add(1 * time.Hour),
		RefreshExpiresAt: now.Add(24 * time.Hour),
	}
	_, err = s.RotateSession(ctx, "rhash_orig", newSess2)
	if !errors.Is(err, ErrReplayDetected) {
		t.Fatalf("expected ErrReplayDetected, got %v", err)
	}

	// The active session in the family must NOW ALSO be revoked!
	_, err = s.GetActiveSessionByTokenHash(ctx, "thash_new_1")
	if !errors.Is(err, ErrSessionRevoked) {
		t.Errorf("expected active session in family to be revoked following replay attack, got %v", err)
	}
}

func TestSessionStore_RevokeSessionByTokenHash(t *testing.T) {
	_, s := setupTestDB(t)
	ctx := context.Background()
	now := time.Now().UTC()

	sess := &AdminSession{
		ID:               "sess_logout",
		TokenHash:        "thash_logout",
		RefreshHash:      "rhash_logout",
		TokenFamilyID:    "fam_logout",
		CreatedAt:        now,
		LastUsedAt:       now,
		ExpiresAt:        now.Add(1 * time.Hour),
		RefreshExpiresAt: now.Add(24 * time.Hour),
	}
	if err := s.CreateSession(ctx, sess); err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	revokedFamily, err := s.RevokeSessionByTokenHash(ctx, "thash_logout", now)
	if err != nil {
		t.Fatalf("RevokeSessionByTokenHash failed: %v", err)
	}
	if revokedFamily != "fam_logout" {
		t.Errorf("expected revoked family fam_logout, got %s", revokedFamily)
	}

	// Verify session is now revoked
	_, err = s.GetActiveSessionByTokenHash(ctx, "thash_logout")
	if !errors.Is(err, ErrSessionRevoked) {
		t.Errorf("expected ErrSessionRevoked, got %v", err)
	}

	// Revoking again should return ErrSessionRevoked
	_, err = s.RevokeSessionByTokenHash(ctx, "thash_logout", now)
	if !errors.Is(err, ErrSessionRevoked) {
		t.Errorf("expected ErrSessionRevoked on re-revoking, got %v", err)
	}
}
