package store

import (
	"context"
	"encoding/json"
	"errors"
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

func TestRevokedDeviceCannotWrite(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "cts.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	now := time.Now()
	pair := func(name string) string {
		t.Helper()
		code, _, err := st.CreatePairingCode(ctx, "", now)
		if err != nil {
			t.Fatal(err)
		}
		id, _, err := st.Pair(ctx, code, name, "brave", now)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	a, b := pair("A"), pair("B")
	gen, _, err := st.Acquire(ctx, a, false, now, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	// Simulates a request authenticated just before the revocation committed.
	if err := st.RevokeDevice(ctx, b, a, now); err != nil {
		t.Fatal(err)
	}

	checks := map[string]error{}
	_, _, checks["acquire"] = st.Acquire(ctx, a, true, now, time.Minute)
	_, _, checks["pairing code"] = st.CreatePairingCode(ctx, a, now)
	checks["release"] = st.Release(ctx, a, gen)
	checks["heartbeat"] = st.Heartbeat(ctx, a, gen, now)
	_, checks["operations"] = st.ApplyOperations(ctx, a, gen, 0, nil, now, 5)
	_, checks["restore"] = st.RestoreSnapshot(ctx, a, gen, 1, now, 5)
	_, checks["merge"] = st.Merge(ctx, a, nil, now, 5)
	checks["revoke"] = st.RevokeDevice(ctx, a, b, now)
	for name, err := range checks {
		if !errors.Is(err, ErrRevoked) {
			t.Errorf("%s by revoked device: %v, want ErrRevoked", name, err)
		}
	}
	sess, err := st.GetSession(ctx)
	if err != nil || sess.Owner != nil {
		t.Fatalf("owner after revocation: %+v %v", sess.Owner, err)
	}
}

func TestTimestampJSON(t *testing.T) {
	t.Parallel()
	b, err := json.Marshal(Timestamp{time.Date(2026, 1, 2, 3, 4, 5, 0, time.FixedZone("x", 3600))})
	if err != nil || string(b) != `"2026-01-02T02:04:05.000Z"` {
		t.Fatalf("got %s %v", b, err)
	}
}
