package store

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/freebuddy/freebuddy/services/remote-relay/internal/store/migrations"
)

// MigrationRecord represents an applied migration record in the database.
type MigrationRecord struct {
	Version   int
	Name      string
	AppliedAt time.Time
}

type migrationFile struct {
	version int
	name    string
	sql     string
}

// RunMigrations applies all pending embedded migrations in sequential order.
func RunMigrations(ctx context.Context, db *sql.DB) error {
	if db == nil {
		return fmt.Errorf("db handle is nil")
	}

	// 1. Create schema_migrations table if not exists
	initTableSQL := `
	CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		applied_at TEXT NOT NULL
	);`
	if _, err := db.ExecContext(ctx, initTableSQL); err != nil {
		return fmt.Errorf("failed to initialize schema_migrations table: %w", err)
	}

	// 2. Query applied migrations
	appliedMap := make(map[int]bool)
	rows, err := db.QueryContext(ctx, "SELECT version FROM schema_migrations ORDER BY version ASC;")
	if err != nil {
		return fmt.Errorf("failed to query applied migrations: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var v int
		if err := rows.Scan(&v); err != nil {
			return fmt.Errorf("failed to scan applied migration version: %w", err)
		}
		appliedMap[v] = true
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("error reading applied migrations: %w", err)
	}

	// 3. Load embedded migration files
	files, err := loadMigrationFiles()
	if err != nil {
		return fmt.Errorf("failed to load migration files: %w", err)
	}

	// 4. Apply pending migrations inside transactions
	for _, m := range files {
		if appliedMap[m.version] {
			continue
		}

		if err := applyMigration(ctx, db, m); err != nil {
			return fmt.Errorf("failed to apply migration version %d (%s): %w", m.version, m.name, err)
		}
	}

	return nil
}

// GetAppliedMigrations returns the list of migrations recorded in the database.
func GetAppliedMigrations(ctx context.Context, db *sql.DB) ([]MigrationRecord, error) {
	if db == nil {
		return nil, fmt.Errorf("db handle is nil")
	}

	// Check if table exists
	var tableExists int
	err := db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='schema_migrations';").Scan(&tableExists)
	if err != nil {
		return nil, fmt.Errorf("failed to check schema_migrations table: %w", err)
	}
	if tableExists == 0 {
		return nil, nil
	}

	rows, err := db.QueryContext(ctx, "SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC;")
	if err != nil {
		return nil, fmt.Errorf("failed to query schema_migrations: %w", err)
	}
	defer rows.Close()

	var records []MigrationRecord
	for rows.Next() {
		var r MigrationRecord
		var appliedAtStr string
		if err := rows.Scan(&r.Version, &r.Name, &appliedAtStr); err != nil {
			return nil, fmt.Errorf("failed to scan migration record: %w", err)
		}
		t, err := time.Parse(time.RFC3339Nano, appliedAtStr)
		if err != nil {
			// Fallback to RFC3339
			t, _ = time.Parse(time.RFC3339, appliedAtStr)
		}
		r.AppliedAt = t
		records = append(records, r)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error reading schema_migrations: %w", err)
	}

	return records, nil
}

func loadMigrationFiles() ([]migrationFile, error) {
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		return nil, fmt.Errorf("failed to read embedded migrations dir: %w", err)
	}

	var files []migrationFile
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}

		parts := strings.SplitN(entry.Name(), "_", 2)
		if len(parts) < 2 {
			return nil, fmt.Errorf("invalid migration filename %q (expected format <version>_<name>.sql)", entry.Name())
		}

		version, err := strconv.Atoi(parts[0])
		if err != nil {
			return nil, fmt.Errorf("invalid migration version prefix in %q: %w", entry.Name(), err)
		}

		content, err := fs.ReadFile(migrations.FS, entry.Name())
		if err != nil {
			return nil, fmt.Errorf("failed to read migration file %q: %w", entry.Name(), err)
		}

		files = append(files, migrationFile{
			version: version,
			name:    entry.Name(),
			sql:     string(content),
		})
	}

	sort.Slice(files, func(i, j int) bool {
		return files[i].version < files[j].version
	})

	return files, nil
}

func applyMigration(ctx context.Context, db *sql.DB, m migrationFile) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, m.sql); err != nil {
		return fmt.Errorf("exec error: %w", err)
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	insertSQL := "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?);"
	if _, err := tx.ExecContext(ctx, insertSQL, m.version, m.name, now); err != nil {
		return fmt.Errorf("failed to record migration: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}
