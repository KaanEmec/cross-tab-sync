package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"fmt"
	"io/fs"
	"testing"
)

// sealed derives deterministic stand-ins for a client's urlKey and urlEnc;
// the server never decodes them.
func sealed(url string) (key, enc string) {
	sum := sha256.Sum256([]byte(url))
	padded := make([]byte, (len(url)+63)/64*64)
	copy(padded, url)
	return base64.RawURLEncoding.EncodeToString(sum[:]), base64.RawURLEncoding.EncodeToString(padded)
}

func key(url string) string { k, _ := sealed(url); return k }
func enc(url string) string { _, e := sealed(url); return e }

// legacyDB opens a raw database without migrations, for migration tests.
func legacyDB(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.ExecContext(context.Background(),
		`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	return db
}

// migrateTo applies migration version (only that one) as Open would, then
// runs the fixture statements.
func migrateTo(t *testing.T, db *sql.DB, version int, fixtures ...string) {
	t.Helper()
	ctx := context.Background()
	names, err := fs.Glob(migrationFS, fmt.Sprintf("migrations/%04d_*.sql", version))
	if err != nil || len(names) != 1 {
		t.Fatalf("migration %d: %v %v", version, names, err)
	}
	body, err := migrationFS.ReadFile(names[0])
	if err != nil {
		t.Fatal(err)
	}
	stmts := append([]string{string(body), fmt.Sprintf(`INSERT INTO schema_migrations VALUES (%d, 0)`, version)}, fixtures...)
	for _, q := range stmts {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatalf("migration %d: %s: %v", version, q, err)
		}
	}
}
