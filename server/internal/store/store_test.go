package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kaanemec/cross-tab-sync/server/internal/session"
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
	dev, _, err := st.Pair(ctx, code, "Mac", "safari", now)
	if err != nil {
		t.Fatal(err)
	}
	id := dev.ID
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
	ds, err := st.ListDevices(ctx, now)
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
		dev, _, err := st.Pair(ctx, code, name, "brave", now)
		if err != nil {
			t.Fatal(err)
		}
		return dev.ID
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

// Upgrading a v1 database to v2 (end-to-end encryption) drops all plaintext
// history, resets the session, revokes every device and coalesces on url_key.
func TestMigration0003E2E(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "cts.db")
	db := legacyDB(t, path)
	migrateTo(t, db, 1,
		`INSERT INTO devices (id, name, browser, token_hash, created_at, last_seen_at) VALUES ('a', 'A', 'brave', x'01', 1, 1)`,
		`INSERT INTO devices (id, name, browser, token_hash, created_at, last_seen_at, revoked_at) VALUES ('b', 'B', 'safari', x'02', 1, 1, 5)`,
		`INSERT INTO entries (id, url, opened_by, created_revision, updated_revision) VALUES ('e1', 'https://a.example/', 'a', 1, 1)`,
		`INSERT INTO entries (id, url, opened_by, created_revision, updated_revision, closed_revision) VALUES ('e2', 'https://b.example/', 'a', 2, 3, 3)`,
		`INSERT INTO operations (op_id, seq, device_id, generation, type, payload, result, created_at)
			VALUES ('o1', 1, 'a', 4, 'open', '{"url":"https://a.example/"}', '{}', 1)`,
		`INSERT INTO snapshots (revision, device_id, reason, created_at, entry_count, entries)
			VALUES (2, 'a', 'operations', 1, 1, '[{"url":"https://a.example/"}]')`,
		`UPDATE session SET revision = 3, generation = 4, owner_device_id = 'a', owner_last_seen_at = 1`)
	migrateTo(t, db, 2, `UPDATE session SET min_revision = 2`)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	before := time.Now().UnixMilli()
	st, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	f := &historyFixture{t: t, st: st}
	for query, want := range map[string]int{
		`SELECT COUNT(*) FROM entries`:    0,
		`SELECT COUNT(*) FROM operations`: 0,
		`SELECT COUNT(*) FROM snapshots`:  0,
		// Revoked in milliseconds like every other timestamp (second precision).
		fmt.Sprintf(`SELECT COUNT(*) FROM devices WHERE id = 'a' AND revoked_at BETWEEN %d AND %d`,
			before-1000, time.Now().UnixMilli()): 1,
		`SELECT COUNT(*) FROM devices WHERE id = 'b' AND revoked_at = 5`: 1,
		`SELECT COUNT(*) FROM session WHERE revision = 0 AND min_revision = 1 AND generation = 4
			AND owner_device_id IS NULL AND owner_last_seen_at IS NULL`: 1,
	} {
		if n := f.count(query); n != want {
			t.Errorf("%s = %d, want %d", query, n, want)
		}
	}

	// A browser pairs again; opens with the same urlKey coalesce.
	now := time.Now()
	code, _, err := st.CreatePairingCode(ctx, "", now)
	if err != nil {
		t.Fatal(err)
	}
	dev, _, err := st.Pair(ctx, code, "A", "brave", now)
	if err != nil {
		t.Fatal(err)
	}
	gen, _, err := st.Acquire(ctx, dev.ID, false, now, time.Minute)
	if err != nil || gen != 5 {
		t.Fatalf("acquire after upgrade: generation %d %v", gen, err)
	}
	k := key("https://a.example/")
	ops := []session.Op{
		{OpID: "00000000-0000-4000-8000-000000000001", Type: session.TypeOpen, EntryID: "10000000-0000-4000-8000-000000000001", URLKey: k, URLEnc: "AAAA"},
		{OpID: "00000000-0000-4000-8000-000000000002", Type: session.TypeOpen, EntryID: "10000000-0000-4000-8000-000000000002", URLKey: k, URLEnc: "BBBB"},
	}
	res, err := st.ApplyOperations(ctx, dev.ID, gen, 0, ops, now, 5)
	if err != nil || res.Revision != 2 || res.Results[0].Status != session.StatusApplied ||
		res.Results[1].Status != session.StatusCoalesced || res.Results[1].EntryID != ops[0].EntryID {
		t.Fatalf("opens after upgrade: %+v %v", res, err)
	}
	sess, err := st.GetSession(ctx)
	if err != nil || len(sess.Entries) != 1 || sess.Entries[0].URLKey != k || sess.Entries[0].URLEnc != "AAAA" {
		t.Fatalf("session after upgrade: %+v %v", sess, err)
	}
	// The database itself enforces one open entry per url_key.
	_, err = st.db.ExecContext(ctx, `INSERT INTO entries (id, url_key, url_enc, opened_by, created_revision, updated_revision)
		VALUES ('dup', ?, 'CCCC', 'x', 3, 3)`, k)
	if err == nil || !strings.Contains(err.Error(), "UNIQUE") {
		t.Fatalf("duplicate open url_key inserted: %v", err)
	}
	if _, err := st.db.ExecContext(ctx, `INSERT INTO entries (id, url_key, url_enc, opened_by, created_revision, updated_revision, closed_revision)
		VALUES ('tomb', ?, 'CCCC', 'x', 3, 3, 3)`, k); err != nil {
		t.Fatalf("tombstone with the same url_key: %v", err)
	}
}

// Snapshots store {id, urlKey, urlEnc, pinned, position}; restore reopens both fields.
func TestSnapshotStoresSealedURLs(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	f := newHistoryFixture(t)
	now := time.Now()
	e1 := f.id()
	f.apply(now, session.Op{OpID: f.id(), Type: session.TypeOpen, EntryID: e1, URLKey: key("https://a.example/"), URLEnc: enc("https://a.example/")})
	f.apply(now, session.Op{OpID: f.id(), Type: session.TypeClose, EntryID: e1})

	var raw string
	if err := f.st.db.QueryRowContext(ctx, `SELECT entries FROM snapshots`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var items []map[string]any
	if err := json.Unmarshal([]byte(raw), &items); err != nil || len(items) != 1 {
		t.Fatalf("snapshot %s: %v", raw, err)
	}
	want := map[string]any{"id": e1, "urlKey": key("https://a.example/"), "urlEnc": enc("https://a.example/"), "pinned": false, "position": float64(0)}
	if fmt.Sprint(items[0]) != fmt.Sprint(want) {
		t.Fatalf("snapshot entry %v, want %v", items[0], want)
	}
	snaps, err := f.st.ListSnapshots(ctx)
	if err != nil || len(snaps) != 1 {
		t.Fatalf("snapshots %+v %v", snaps, err)
	}
	if _, err := f.st.RestoreSnapshot(ctx, f.dev, f.gen, snaps[0].ID, now, 5); err != nil {
		t.Fatal(err)
	}
	sess, err := f.st.GetSession(ctx)
	if err != nil || len(sess.Entries) != 1 || sess.Entries[0].URLKey != key("https://a.example/") ||
		sess.Entries[0].URLEnc != enc("https://a.example/") {
		t.Fatalf("restored session %+v %v", sess, err)
	}
	cs, err := f.st.Changes(ctx, 2)
	if err != nil || len(cs.Operations) != 1 || !strings.Contains(string(cs.Operations[0].Op), `"urlEnc":"`+enc("https://a.example/")+`"`) {
		t.Fatalf("restore op %+v %v", cs, err)
	}
}
