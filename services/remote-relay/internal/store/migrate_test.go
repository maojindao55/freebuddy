package store

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestRunMigrations_EmptyDB(t *testing.T) {
	db, err := Open(":memory:")
	if err != nil {
		t.Fatalf("failed to open in-memory db: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := RunMigrations(ctx, db.DB); err != nil {
		t.Fatalf("failed to run migrations: %v", err)
	}

	records, err := GetAppliedMigrations(ctx, db.DB)
	if err != nil {
		t.Fatalf("failed to get applied migrations: %v", err)
	}

	if len(records) == 0 {
		t.Fatal("expected at least one applied migration")
	}

	if records[0].Version != 1 {
		t.Errorf("expected version 1, got %d", records[0].Version)
	}
}

func TestRunMigrations_Idempotency(t *testing.T) {
	db, err := Open(":memory:")
	if err != nil {
		t.Fatalf("failed to open in-memory db: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Run first time
	if err := RunMigrations(ctx, db.DB); err != nil {
		t.Fatalf("first RunMigrations failed: %v", err)
	}

	// Run second time (should be a no-op and succeed)
	if err := RunMigrations(ctx, db.DB); err != nil {
		t.Fatalf("second RunMigrations failed: %v", err)
	}

	records, err := GetAppliedMigrations(ctx, db.DB)
	if err != nil {
		t.Fatalf("failed to get applied migrations: %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("expected exactly 1 migration record, got %d", len(records))
	}
}

func TestSchema_TablesAndColumns_StrictDataBoundary(t *testing.T) {
	db, err := Open(":memory:")
	if err != nil {
		t.Fatalf("failed to open in-memory db: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := RunMigrations(ctx, db.DB); err != nil {
		t.Fatalf("failed to run migrations: %v", err)
	}

	// Expected tables
	expectedTables := map[string][]string{
		"admin_sessions": {
			"id", "token_hash", "refresh_hash", "token_family_id",
			"device_label", "created_at", "last_used_at", "expires_at",
			"refresh_expires_at", "revoked_at",
		},
		"hosts": {
			"id", "public_key", "display_name", "paired_at",
			"last_seen_at", "revoked_at",
		},
		"pairings": {
			"id", "secret_hash", "public_key", "display_name",
			"created_at", "expires_at", "claimed_at",
		},
		"audit_events": {
			"id", "occurred_at", "actor_type", "actor_id",
			"action", "target_type", "target_id", "outcome",
			"request_id", "remote_ip_hash",
		},
		"schema_migrations": {
			"version", "name", "applied_at",
		},
	}

	// Check table existence and columns
	for table, expectedCols := range expectedTables {
		rows, err := db.QueryContext(ctx, fmt.Sprintf("PRAGMA table_info(%s);", table))
		if err != nil {
			t.Fatalf("failed to get table_info for %s: %v", table, err)
		}

		actualCols := make(map[string]bool)
		for rows.Next() {
			var cid int
			var name, colType string
			var notnull, pk int
			var dfltValue interface{}
			if err := rows.Scan(&cid, &name, &colType, &notnull, &dfltValue, &pk); err != nil {
				rows.Close()
				t.Fatalf("failed to scan table_info for %s: %v", table, err)
			}
			actualCols[name] = true
		}
		rows.Close()

		if len(actualCols) == 0 {
			t.Errorf("table %s was not created", table)
			continue
		}

		for _, col := range expectedCols {
			if !actualCols[col] {
				t.Errorf("table %s missing expected column %s", table, col)
			}
		}
	}

	// Strict payload leak assertion:
	// 1. Fetch all table names first into slice to avoid holding connection open
	var tableNames []string
	tableRows, err := db.QueryContext(ctx, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")
	if err != nil {
		t.Fatalf("failed to list tables: %v", err)
	}
	for tableRows.Next() {
		var tbl string
		if err := tableRows.Scan(&tbl); err != nil {
			tableRows.Close()
			t.Fatalf("failed to scan table name: %v", err)
		}
		tableNames = append(tableNames, tbl)
	}
	tableRows.Close()

	// 2. Verify that NO forbidden column names exist in any table
	forbiddenSubstrings := []string{
		"payload", "message", "chat", "content", "code", "terminal",
		"token_raw", "plain_token", "app_secret", "private_key",
		"params", "result", "body", "input", "output", "stream",
	}

	for _, tbl := range tableNames {
		colsRows, err := db.QueryContext(ctx, fmt.Sprintf("PRAGMA table_info(%s);", tbl))
		if err != nil {
			t.Fatalf("failed to query columns for %s: %v", tbl, err)
		}

		for colsRows.Next() {
			var cid int
			var name, colType string
			var notnull, pk int
			var dfltValue interface{}
			if err := colsRows.Scan(&cid, &name, &colType, &notnull, &dfltValue, &pk); err != nil {
				colsRows.Close()
				t.Fatalf("failed to scan column for %s: %v", tbl, err)
			}

			lowerName := strings.ToLower(name)
			for _, forbidden := range forbiddenSubstrings {
				if strings.Contains(lowerName, forbidden) {
					t.Errorf("SECURITY VIOLATION: table %s contains forbidden column name %s (matched %s)", tbl, name, forbidden)
				}
			}
		}
		colsRows.Close()
	}
}
