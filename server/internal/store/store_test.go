package store

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMigrationsFreshAndIdempotent(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "nested", "cts.db")

	st, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	ms, err := migrations()
	if err != nil {
		t.Fatal(err)
	}
	countVersions := func(st *Store) int {
		t.Helper()
		var n int
		if err := st.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if got := countVersions(st); got != len(ms) || got == 0 {
		t.Fatalf("applied %d migrations, want %d", got, len(ms))
	}
	var mode string
	if err := st.db.QueryRowContext(ctx, `PRAGMA journal_mode`).Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("journal_mode = %q, %v", mode, err)
	}
	if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("db permissions: %v %v", fi.Mode(), err)
	}

	now := time.Now()
	code, _, err := st.CreatePairingCode(ctx, "", now)
	if err != nil {
		t.Fatal(err)
	}
	id, _, err := st.Pair(ctx, code, "Mac", "safari", now)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	// Reopen: no migration re-applied, data persisted.
	st, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if got := countVersions(st); got != len(ms) {
		t.Fatalf("after restart %d migration rows, want %d", got, len(ms))
	}
	ds, err := st.ListDevices(ctx)
	if err != nil || len(ds) != 1 || ds[0].ID != id {
		t.Fatalf("devices after restart: %+v %v", ds, err)
	}
	sess, err := st.GetSession(ctx)
	if err != nil || sess.Revision != 0 || sess.Owner != nil {
		t.Fatalf("session after restart: %+v %v", sess, err)
	}
}

func TestNormalizeCode(t *testing.T) {
	t.Parallel()
	if got := NormalizeCode(" abcd-efgh "); got != "ABCDEFGH" {
		t.Fatalf("got %q", got)
	}
	code, err := newCode()
	if err != nil || len(code) != CodeLength {
		t.Fatalf("newCode() = %q, %v", code, err)
	}
	for _, c := range code {
		if !strings.ContainsRune(CodeAlphabet, c) {
			t.Fatalf("code %q has %q outside the alphabet", code, c)
		}
	}
}
