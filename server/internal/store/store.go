// Package store persists devices, pairing codes, the shared session, the
// operation log and recovery snapshots in SQLite.
package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite" // registers the "sqlite" driver
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Domain errors returned by the store.
var (
	ErrInvalidCode    = errors.New("invalid or expired pairing code")
	ErrUnauthorized   = errors.New("unknown token")
	ErrRevoked        = errors.New("device revoked")
	ErrNotFound       = errors.New("not found")
	ErrHistoryExpired = errors.New("history expired")
)

// Conflict codes carried by ConflictError.
const (
	CodeOwnerActive = "owner_active"
	CodeStaleOwner  = "stale_owner"
)

// ConflictError reports an ownership conflict together with the current owner.
type ConflictError struct {
	Code  string // CodeOwnerActive or CodeStaleOwner
	Owner *Owner // nil when the session has no owner
}

func (e *ConflictError) Error() string { return e.Code }

// Store wraps the SQLite database.
type Store struct {
	db *sql.DB
}

// Open opens (creating if needed) the database at path and applies pending
// migrations.
func Open(ctx context.Context, dbPath string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o700); err != nil {
		return nil, fmt.Errorf("creating database directory: %w", err)
	}
	// Every connection gets the pragmas; BEGIN IMMEDIATE takes the write lock
	// up front so read-then-write transactions never fail on lock upgrade.
	dsn := dbPath + "?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)" +
		"&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)&_txlock=immediate"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("opening database: %w", err)
	}
	// SQLite has a single writer; one connection serializes all access in
	// this process and avoids busy waits. Other processes (the CLI) rely on
	// busy_timeout.
	db.SetMaxOpenConns(1)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("connecting to database: %w", err)
	}
	// The database holds URLs; keep it private to the service user.
	if err := os.Chmod(dbPath, 0o600); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("restricting database permissions: %w", err)
	}
	s := &Store{db: db}
	if err := s.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// Ping checks the database connection.
func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

type migration struct {
	version int
	name    string
}

func migrations() ([]migration, error) {
	names, err := fs.Glob(migrationFS, "migrations/*.sql")
	if err != nil {
		return nil, fmt.Errorf("listing migrations: %w", err)
	}
	out := make([]migration, 0, len(names))
	seen := map[int]bool{}
	for _, n := range names {
		base := path.Base(n)
		prefix, _, _ := strings.Cut(base, "_")
		v, err := strconv.Atoi(prefix)
		if err != nil || v <= 0 {
			return nil, fmt.Errorf("migration %s: name must start with a positive number", base)
		}
		if seen[v] {
			return nil, fmt.Errorf("migration %s: duplicate version %d", base, v)
		}
		seen[v] = true
		out = append(out, migration{version: v, name: n})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	return out, nil
}

func (s *Store) migrate(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`); err != nil {
		return fmt.Errorf("creating schema_migrations: %w", err)
	}
	ms, err := migrations()
	if err != nil {
		return err
	}
	for _, m := range ms {
		body, err := migrationFS.ReadFile(m.name)
		if err != nil {
			return fmt.Errorf("reading migration %s: %w", m.name, err)
		}
		err = s.tx(ctx, func(tx *sql.Tx) error {
			var n int
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations WHERE version = ?`, m.version).Scan(&n); err != nil {
				return err
			}
			if n > 0 {
				return nil
			}
			if _, err := tx.ExecContext(ctx, string(body)); err != nil {
				return err
			}
			_, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
				m.version, time.Now().UnixMilli())
			return err
		})
		if err != nil {
			return fmt.Errorf("applying migration %s: %w", path.Base(m.name), err)
		}
	}
	return nil
}

// tx runs fn in a transaction, committing on success.
func (s *Store) tx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("committing transaction: %w", err)
	}
	return nil
}

func ms(t time.Time) int64 { return t.UnixMilli() }

func fromMS(v int64) time.Time { return time.UnixMilli(v).UTC() }
