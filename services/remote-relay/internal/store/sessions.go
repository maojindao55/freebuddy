package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

var (
	// ErrSessionNotFound indicates the session was not found in the database.
	ErrSessionNotFound = errors.New("admin session not found")
	// ErrSessionExpired indicates the session or refresh token has expired.
	ErrSessionExpired = errors.New("admin session expired")
	// ErrSessionRevoked indicates the session has already been revoked.
	ErrSessionRevoked = errors.New("admin session revoked")
	// ErrReplayDetected indicates a revoked refresh token was used, triggering family revocation.
	ErrReplayDetected = errors.New("refresh token replay detected: token family revoked")
)

// AdminSession models an active or revoked admin session record.
// Note: Raw tokens are NEVER stored in this struct or the database. Only hashes.
type AdminSession struct {
	ID               string
	TokenHash        string
	RefreshHash      string
	TokenFamilyID    string
	DeviceLabel      string
	CreatedAt        time.Time
	LastUsedAt       time.Time
	ExpiresAt        time.Time
	RefreshExpiresAt time.Time
	RevokedAt        *time.Time
}

// SessionStore defines the persistence interface for managing admin sessions.
type SessionStore interface {
	CreateSession(ctx context.Context, s *AdminSession) error
	GetActiveSessionByTokenHash(ctx context.Context, tokenHash string) (*AdminSession, error)
	TouchSession(ctx context.Context, id string, lastUsedAt time.Time) error
	RotateSession(ctx context.Context, oldRefreshHash string, newSession *AdminSession) (*AdminSession, error)
	RevokeSessionByTokenHash(ctx context.Context, tokenHash string, now time.Time) (revokedFamilyID string, err error)
	RevokeFamily(ctx context.Context, familyID string, now time.Time) error
}

// SQLiteSessionStore implements SessionStore on top of a SQLite database.
type SQLiteSessionStore struct {
	db *sql.DB
}

// NewSessionStore creates a new SQLite-backed SessionStore.
func NewSessionStore(db *sql.DB) *SQLiteSessionStore {
	return &SQLiteSessionStore{db: db}
}

// CreateSession inserts a new admin session record into the database.
func (s *SQLiteSessionStore) CreateSession(ctx context.Context, session *AdminSession) error {
	if session == nil {
		return errors.New("cannot create nil session")
	}

	query := `INSERT INTO admin_sessions (
		id, token_hash, refresh_hash, token_family_id, device_label,
		created_at, last_used_at, expires_at, refresh_expires_at, revoked_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`

	_, err := s.db.ExecContext(ctx, query,
		session.ID,
		session.TokenHash,
		session.RefreshHash,
		session.TokenFamilyID,
		session.DeviceLabel,
		session.CreatedAt.UTC().Format(time.RFC3339Nano),
		session.LastUsedAt.UTC().Format(time.RFC3339Nano),
		session.ExpiresAt.UTC().Format(time.RFC3339Nano),
		session.RefreshExpiresAt.UTC().Format(time.RFC3339Nano),
	)
	if err != nil {
		return fmt.Errorf("failed to insert admin session: %w", err)
	}
	return nil
}

// GetActiveSessionByTokenHash looks up an unrevoked, non-expired session by token hash.
func (s *SQLiteSessionStore) GetActiveSessionByTokenHash(ctx context.Context, tokenHash string) (*AdminSession, error) {
	query := `SELECT id, token_hash, refresh_hash, token_family_id, device_label,
	                 created_at, last_used_at, expires_at, refresh_expires_at, revoked_at
	          FROM admin_sessions
	          WHERE token_hash = ?`

	row := s.db.QueryRowContext(ctx, query, tokenHash)

	var (
		sess             AdminSession
		createdAtStr     string
		lastUsedAtStr    string
		expiresAtStr     string
		refreshExpStr    string
		revokedAtNullStr sql.NullString
	)

	err := row.Scan(
		&sess.ID,
		&sess.TokenHash,
		&sess.RefreshHash,
		&sess.TokenFamilyID,
		&sess.DeviceLabel,
		&createdAtStr,
		&lastUsedAtStr,
		&expiresAtStr,
		&refreshExpStr,
		&revokedAtNullStr,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrSessionNotFound
		}
		return nil, fmt.Errorf("failed to scan session: %w", err)
	}

	if revokedAtNullStr.Valid && revokedAtNullStr.String != "" {
		return nil, ErrSessionRevoked
	}

	createdAt, _ := parseTimestamp(createdAtStr)
	lastUsedAt, _ := parseTimestamp(lastUsedAtStr)
	expiresAt, err := parseTimestamp(expiresAtStr)
	if err != nil {
		return nil, fmt.Errorf("invalid expires_at in db: %w", err)
	}
	refreshExp, _ := parseTimestamp(refreshExpStr)

	now := time.Now().UTC()
	if expiresAt.Before(now) {
		return nil, ErrSessionExpired
	}

	sess.CreatedAt = createdAt
	sess.LastUsedAt = lastUsedAt
	sess.ExpiresAt = expiresAt
	sess.RefreshExpiresAt = refreshExp

	return &sess, nil
}

// TouchSession updates the last_used_at timestamp of an active session.
func (s *SQLiteSessionStore) TouchSession(ctx context.Context, id string, lastUsedAt time.Time) error {
	query := `UPDATE admin_sessions SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL`
	_, err := s.db.ExecContext(ctx, query, lastUsedAt.UTC().Format(time.RFC3339Nano), id)
	return err
}

// RotateSession atomically invalidates an old refresh token and issues a new session in the same family.
// If a revoked refresh token is presented, replay attack is detected and the entire token family is revoked.
func (s *SQLiteSessionStore) RotateSession(ctx context.Context, oldRefreshHash string, newSession *AdminSession) (*AdminSession, error) {
	if newSession == nil {
		return nil, errors.New("new session cannot be nil")
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	query := `SELECT id, token_family_id, device_label, refresh_expires_at, revoked_at
	          FROM admin_sessions
	          WHERE refresh_hash = ?`

	var (
		id            string
		tokenFamilyID string
		deviceLabel   string
		refreshExpStr string
		revokedAtStr  sql.NullString
	)

	row := tx.QueryRowContext(ctx, query, oldRefreshHash)
	if err := row.Scan(&id, &tokenFamilyID, &deviceLabel, &refreshExpStr, &revokedAtStr); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrSessionNotFound
		}
		return nil, fmt.Errorf("failed to scan session for refresh: %w", err)
	}

	now := time.Now().UTC()
	nowStr := now.Format(time.RFC3339Nano)

	// Replay attack detection: if this refresh token was already revoked, revoke the whole family!
	if revokedAtStr.Valid && revokedAtStr.String != "" {
		_, _ = tx.ExecContext(ctx,
			`UPDATE admin_sessions SET revoked_at = ? WHERE token_family_id = ? AND revoked_at IS NULL`,
			nowStr, tokenFamilyID)
		_ = tx.Commit()
		return nil, ErrReplayDetected
	}

	// Expiry check
	refreshExpiresAt, err := parseTimestamp(refreshExpStr)
	if err == nil && refreshExpiresAt.Before(now) {
		return nil, ErrSessionExpired
	}

	// Revoke the old session
	if _, err := tx.ExecContext(ctx, `UPDATE admin_sessions SET revoked_at = ? WHERE id = ?`, nowStr, id); err != nil {
		return nil, fmt.Errorf("failed to revoke old session: %w", err)
	}

	// Link new session to the existing token family and device label
	newSession.TokenFamilyID = tokenFamilyID
	if newSession.DeviceLabel == "" {
		newSession.DeviceLabel = deviceLabel
	}

	insertQuery := `INSERT INTO admin_sessions (
		id, token_hash, refresh_hash, token_family_id, device_label,
		created_at, last_used_at, expires_at, refresh_expires_at, revoked_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`

	_, err = tx.ExecContext(ctx, insertQuery,
		newSession.ID,
		newSession.TokenHash,
		newSession.RefreshHash,
		newSession.TokenFamilyID,
		newSession.DeviceLabel,
		newSession.CreatedAt.UTC().Format(time.RFC3339Nano),
		newSession.LastUsedAt.UTC().Format(time.RFC3339Nano),
		newSession.ExpiresAt.UTC().Format(time.RFC3339Nano),
		newSession.RefreshExpiresAt.UTC().Format(time.RFC3339Nano),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to insert rotated session: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("failed to commit session rotation: %w", err)
	}

	return newSession, nil
}

// RevokeSessionByTokenHash revokes the session matching tokenHash and any unrevoked sessions in its token family.
// Returns the revoked family ID.
func (s *SQLiteSessionStore) RevokeSessionByTokenHash(ctx context.Context, tokenHash string, now time.Time) (string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	query := `SELECT id, token_family_id, revoked_at FROM admin_sessions WHERE token_hash = ?`
	var (
		id            string
		tokenFamilyID string
		revokedAtStr  sql.NullString
	)

	row := tx.QueryRowContext(ctx, query, tokenHash)
	if err := row.Scan(&id, &tokenFamilyID, &revokedAtStr); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", ErrSessionNotFound
		}
		return "", fmt.Errorf("failed to query session for revocation: %w", err)
	}

	if revokedAtStr.Valid && revokedAtStr.String != "" {
		return "", ErrSessionRevoked
	}

	nowStr := now.UTC().Format(time.RFC3339Nano)
	// Revoke the entire family to prevent refresh after explicit logout
	updateQuery := `UPDATE admin_sessions SET revoked_at = ? WHERE token_family_id = ? AND revoked_at IS NULL`
	if _, err := tx.ExecContext(ctx, updateQuery, nowStr, tokenFamilyID); err != nil {
		return "", fmt.Errorf("failed to revoke sessions in family: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return "", fmt.Errorf("failed to commit revocation: %w", err)
	}

	return tokenFamilyID, nil
}

// RevokeFamily revokes all active sessions belonging to the given token family.
func (s *SQLiteSessionStore) RevokeFamily(ctx context.Context, familyID string, now time.Time) error {
	nowStr := now.UTC().Format(time.RFC3339Nano)
	query := `UPDATE admin_sessions SET revoked_at = ? WHERE token_family_id = ? AND revoked_at IS NULL`
	_, err := s.db.ExecContext(ctx, query, nowStr, familyID)
	return err
}

func parseTimestamp(s string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		t, err = time.Parse(time.RFC3339, s)
	}
	return t, err
}
