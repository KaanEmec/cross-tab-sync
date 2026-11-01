package store

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kaanemec/cross-tab-sync/server/internal/session"
)

// sessionTables hold rows that belong to a session.
var sessionTables = []string{"devices", "pairing_codes", "entries", "operations", "snapshots"}

// rowsOf counts the rows of session sid in sessions and every session table.
func rowsOf(t *testing.T, st *Store, sid int64) map[string]int {
	t.Helper()
	out := map[string]int{}
	for _, table := range append([]string{"sessions"}, sessionTables...) {
		col := "session_id"
		if table == "sessions" {
			col = "id"
		}
		var n int
		if err := st.db.QueryRowContext(context.Background(),
			fmt.Sprintf(`SELECT COUNT(*) FROM %s WHERE %s = ?`, table, col), sid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		out[table] = n
	}
	return out
}

func sessionOf(t *testing.T, st *Store, deviceID string) int64 {
	t.Helper()
	var sid int64
	if err := st.db.QueryRowContext(context.Background(), `SELECT session_id FROM devices WHERE id = ?`, deviceID).Scan(&sid); err != nil {
		t.Fatal(err)
	}
	return sid
}

// v2Fixture is a v2 database (migrations 1-3) with active devices a and b,
// revoked devices c and d whose names collide (ignoring case) with a and with
// each other, an owner, entries, operations, a snapshot and a pairing code.
// stmts adjust it.
func v2Fixture(t *testing.T, stmts ...string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "cts.db")
	db := legacyDB(t, path)
	migrateTo(t, db, 1)
	migrateTo(t, db, 2)
	migrateTo(t, db, 3, append([]string{
		fmt.Sprintf(`INSERT INTO devices (id, name, browser, token_hash, created_at, last_seen_at) VALUES
			('a', 'Brave on macOS', 'brave', x'%x', 1, 1),
			('b', 'Brave on macOS 2', 'brave', x'%x', 2, 2)`, hash("cts_a"), hash("cts_b")),
		`INSERT INTO devices (id, name, browser, token_hash, created_at, last_seen_at, revoked_at) VALUES
			('c', 'brave on MACOS', 'brave', x'03', 3, 3, 3),
			('d', 'BRAVE ON MACOS', 'brave', x'04', 4, 4, 4)`,
		`UPDATE session SET revision = 2, generation = 7, owner_device_id = 'a', owner_last_seen_at = 5, key_check = '` + key("k") + `'`,
		`INSERT INTO entries (id, url_key, url_enc, opened_by, created_revision, updated_revision, url_revision, url_device)
			VALUES ('00000000-0000-4000-8000-0000000000e1', '` + key("https://a.example/") + `', 'AAAA', 'a', 1, 1, 1, 'a')`,
		`INSERT INTO entries (id, url_key, url_enc, opened_by, created_revision, updated_revision, closed_revision, url_revision, url_device)
			VALUES ('00000000-0000-4000-8000-0000000000e2', '` + key("https://b.example/") + `', 'BBBB', 'a', 1, 2, 2, 1, 'a')`,
		`INSERT INTO operations (op_id, seq, device_id, generation, type, payload, result, created_at) VALUES
			('00000000-0000-4000-8000-000000000001', 1, 'a', 7, 'open', '{}', '{"opId":"00000000-0000-4000-8000-000000000001","status":"applied"}', 1),
			('00000000-0000-4000-8000-000000000002', 2, 'a', 7, 'close', '{}', '{"opId":"00000000-0000-4000-8000-000000000002","status":"applied"}', 1)`,
		`INSERT INTO snapshots (id, revision, device_id, reason, created_at, entry_count, entries) VALUES (4, 1, 'a', 'operations', 1, 0, '[]')`,
		`INSERT INTO pairing_codes (code_hash, created_by, created_at, expires_at) VALUES (x'09', 'a', 1, 2)`,
	}, stmts...)...)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

// A usable v2 session (key check and an active device) becomes one v3
// session with all its rows; its devices keep working.
func TestMigration0004KeepsUsableSession(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	st, err := Open(ctx, v2Fixture(t))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	dev, err := st.Authenticate(ctx, "cts_a", time.UnixMilli(10))
	if err != nil || dev.ID != "a" {
		t.Fatalf("authenticate after upgrade: %+v %v", dev, err)
	}
	sid := sessionOf(t, st, "a")
	want := map[string]int{"sessions": 1, "devices": 4, "pairing_codes": 1, "entries": 2, "operations": 2, "snapshots": 1}
	if got := rowsOf(t, st, sid); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("rows %v, want %v", got, want)
	}
	sess, err := st.GetSession(ctx, "a")
	if err != nil || sess.Revision != 2 || sess.KeyCheck != key("k") || sess.Owner == nil || sess.Owner.DeviceID != "a" ||
		sess.Owner.Generation != 7 || len(sess.Entries) != 1 {
		t.Fatalf("session after upgrade: %+v %v", sess, err)
	}
	ds, err := st.ListDevices(ctx, "b", time.UnixMilli(10))
	if err != nil || len(ds) != 4 || ds[0].Name != "Brave on macOS" || ds[1].Name != "Brave on macOS 2" ||
		ds[2].Name != "BRAVE ON MACOS" || ds[3].Name != "brave on MACOS" {
		t.Fatalf("devices after upgrade (names unchanged): %+v %v", ds, err)
	}
	// Revoked devices hold no names; active ones do (b's own aside).
	if d, err := st.RenameDevice(ctx, "b", "BRAVE on macos"); err != nil || d.Name != "BRAVE on macos 2" {
		t.Fatalf("rename after upgrade: %+v %v", d, err)
	}
	snaps, err := st.ListSnapshots(ctx, "a")
	if err != nil || len(snaps) != 1 || snaps[0].ID != 4 {
		t.Fatalf("snapshots after upgrade: %+v %v", snaps, err)
	}
	// The log continues; a replayed opId is still a replay.
	now := time.Now()
	res, err := st.ApplyOperations(ctx, "a", 7, 2, []session.Op{
		{OpID: "00000000-0000-4000-8000-000000000001", Type: session.TypeOpen, EntryID: "00000000-0000-4000-8000-0000000000e1", URLKey: key("x"), URLEnc: "AAAA"},
		{OpID: "00000000-0000-4000-8000-000000000003", Type: session.TypeOpen, EntryID: "00000000-0000-4000-8000-0000000000e3", URLKey: key("https://c.example/"), URLEnc: "CCCC"},
	}, now, 5)
	if err != nil || res.Revision != 3 || !res.Results[0].Replayed || res.Results[1].Status != session.StatusApplied {
		t.Fatalf("operations after upgrade: %+v %v", res, err)
	}
	// The next snapshot continues the session's numbering.
	if _, err := st.ApplyOperations(ctx, "a", 7, 3, []session.Op{
		{OpID: "00000000-0000-4000-8000-000000000004", Type: session.TypeClose, EntryID: "00000000-0000-4000-8000-0000000000e3"},
	}, now, 5); err != nil {
		t.Fatal(err)
	}
	if snaps, err := st.ListSnapshots(ctx, "a"); err != nil || len(snaps) != 2 || snaps[0].ID != 5 {
		t.Fatalf("snapshots: %+v %v", snaps, err)
	}
	// New sessions get fresh ids.
	other, _, err := st.CreateSession(ctx, key("other"), "X", "safari", now, 0)
	if err != nil || sessionOf(t, st, other.ID) == sid {
		t.Fatalf("new session: %v", err)
	}
}

// A v2 session nobody can use again is dropped with all its data.
func TestMigration0004DropsUnusableSession(t *testing.T) {
	t.Parallel()
	for name, stmt := range map[string]string{
		"no key check":      `UPDATE session SET key_check = NULL`,
		"no active devices": `UPDATE devices SET revoked_at = 9`,
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			st, err := Open(context.Background(), v2Fixture(t, stmt))
			if err != nil {
				t.Fatal(err)
			}
			defer st.Close()
			for _, table := range append([]string{"sessions"}, sessionTables...) {
				f := &historyFixture{t: t, st: st}
				if n := f.count(`SELECT COUNT(*) FROM ` + table); n != 0 {
					t.Errorf("%s: %d rows", table, n)
				}
			}
			if _, err := st.Authenticate(context.Background(), "cts_a", time.Now()); !errors.Is(err, ErrUnauthorized) {
				t.Fatalf("old token: %v", err)
			}
		})
	}
}

// Revoking a session's last active device deletes the session and all its
// rows at once; other sessions are untouched.
func TestRevokeLastDeviceDeletesSession(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	f := newHistoryFixture(t)
	g := newHistoryFixtureIn(t, f.st)
	now := time.Now()
	for _, h := range []*historyFixture{f, g} {
		e := h.id()
		h.apply(now, session.Op{OpID: h.id(), Type: session.TypeOpen, EntryID: e, URLKey: key("https://a.example/"), URLEnc: "AAAA"},
			session.Op{OpID: h.id(), Type: session.TypeClose, EntryID: e})
	}
	code, _, err := f.st.CreatePairingCode(ctx, f.dev, now)
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := f.st.Pair(ctx, code, "B", "safari", now, 10)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.st.CreatePairingCode(ctx, b.ID, now); err != nil {
		t.Fatal(err)
	}
	sid, other := sessionOf(t, f.st, f.dev), sessionOf(t, f.st, g.dev)
	before := rowsOf(t, f.st, other)

	if err := f.st.RevokeDevice(ctx, f.dev, b.ID, now); err != nil {
		t.Fatal(err)
	}
	if rows := rowsOf(t, f.st, sid); rows["sessions"] != 1 || rows["devices"] != 2 {
		t.Fatalf("session with an active device left: %v", rows)
	}
	// Devices of another session are unknown.
	if err := f.st.RevokeDevice(ctx, f.dev, g.dev, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoke across sessions: %v", err)
	}
	if err := f.st.RevokeDevice(ctx, f.dev, f.dev, now); err != nil {
		t.Fatal(err)
	}
	for table, n := range rowsOf(t, f.st, sid) {
		if n != 0 {
			t.Errorf("%s: %d rows of the deleted session", table, n)
		}
	}
	if after := rowsOf(t, f.st, other); fmt.Sprint(after) != fmt.Sprint(before) {
		t.Fatalf("other session changed: %v -> %v", before, after)
	}
	if _, err := f.st.GetSession(ctx, f.dev); !errors.Is(err, ErrRevoked) {
		t.Fatalf("deleted session: %v", err)
	}
}

// The prune deletes sessions whose devices were all last seen before the
// session retention; history retention runs per session.
func TestPruneDeletesInactiveSessions(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	f := newHistoryFixture(t)
	g := newHistoryFixtureIn(t, f.st)
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	set := func(q string, args ...any) {
		t.Helper()
		if _, err := f.st.db.ExecContext(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	set(`UPDATE devices SET last_seen_at = ?`, ms(t0))
	f.apply(t0, session.Op{OpID: f.id(), Type: session.TypeOpen, EntryID: f.id(), URLKey: key("https://a.example/"), URLEnc: "AAAA"})
	g.apply(t0.Add(40*day), session.Op{OpID: g.id(), Type: session.TypeOpen, EntryID: g.id(), URLKey: key("https://a.example/"), URLEnc: "AAAA"})

	// f's device is seen again after 100 days through a second device; g's never.
	code, _, err := f.st.CreatePairingCode(ctx, f.dev, t0)
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := f.st.Pair(ctx, code, "B", "safari", t0, 10)
	if err != nil {
		t.Fatal(err)
	}
	set(`UPDATE devices SET last_seen_at = ? WHERE id = ?`, ms(t0.Add(100*day)), b.ID)

	sid, gid := sessionOf(t, f.st, f.dev), sessionOf(t, f.st, g.dev)
	res, err := f.st.Prune(ctx, t0.Add(45*day), 30*day, 180*day)
	if err != nil || res != (PruneResult{Operations: 1}) {
		t.Fatalf("history prune: %+v %v", res, err)
	}
	if f.session().MinRevision != 2 || g.session().MinRevision != 1 {
		t.Fatalf("minRevision per session: %d %d", f.session().MinRevision, g.session().MinRevision)
	}

	res, err = f.st.Prune(ctx, t0.Add(181*day), 30*day, 180*day)
	if err != nil || res.Sessions != 1 {
		t.Fatalf("session prune: %+v %v", res, err)
	}
	if rows := rowsOf(t, f.st, gid); rows["sessions"]+rows["devices"]+rows["entries"]+rows["operations"] != 0 {
		t.Fatalf("inactive session left rows: %v", rows)
	}
	if rows := rowsOf(t, f.st, sid); rows["sessions"] != 1 || rows["devices"] != 2 {
		t.Fatalf("active session pruned: %v", rows)
	}
	if res, err := f.st.Prune(ctx, t0.Add(281*day), 30*day, 180*day); err != nil || res.Sessions != 1 {
		t.Fatalf("last session prune: %+v %v", res, err)
	}
}

// A session keeps at most MaxLiveCodes live codes; a new one replaces the
// oldest. Codes are found by their hash and join their own session.
func TestPairingCodesCappedPerSession(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	f := newHistoryFixture(t)
	g := newHistoryFixtureIn(t, f.st)
	t0 := time.Now()
	var codes []string
	for i := range MaxLiveCodes + 2 {
		code, _, err := f.st.CreatePairingCode(ctx, f.dev, t0.Add(time.Duration(i)*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		codes = append(codes, code)
	}
	other, _, err := g.st.CreatePairingCode(ctx, g.dev, t0)
	if err != nil {
		t.Fatal(err)
	}
	if n := f.count(`SELECT COUNT(*) FROM pairing_codes`); n != MaxLiveCodes+1 {
		t.Fatalf("live codes %d, want %d", n, MaxLiveCodes+1)
	}
	at := t0.Add(time.Minute)
	for _, code := range codes[:2] {
		if _, _, err := f.st.Pair(ctx, code, "X", "brave", at, 100); !errors.Is(err, ErrInvalidCode) {
			t.Fatalf("replaced code: %v", err)
		}
	}
	for i, code := range codes[2:] {
		d, _, err := f.st.Pair(ctx, code, fmt.Sprintf("D%d", i), "brave", at, 100)
		if err != nil || sessionOf(t, f.st, d.ID) != sessionOf(t, f.st, f.dev) {
			t.Fatalf("code %d: %v", i, err)
		}
	}
	d, _, err := g.st.Pair(ctx, other, "Y", "brave", at, 100)
	if err != nil || sessionOf(t, f.st, d.ID) != sessionOf(t, f.st, g.dev) {
		t.Fatalf("other session's code: %v", err)
	}
	// Used codes do not count as live: a new code keeps the cap's room.
	if _, _, err := f.st.CreatePairingCode(ctx, f.dev, at); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.st.Pair(ctx, codes[2], "Z", "brave", at, 100); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("reused code: %v", err)
	}
}

// Pairing looks the code up by its hash instead of scanning live codes.
func TestPairLooksUpCodeByHash(t *testing.T) {
	t.Parallel()
	f := newHistoryFixture(t)
	rows, err := f.st.db.QueryContext(context.Background(),
		`EXPLAIN QUERY PLAN SELECT session_id FROM pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`, hash("x"), 0)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var plan string
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatal(err)
		}
		plan += detail + "; "
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(plan, "USING INDEX") && !strings.Contains(plan, "PRIMARY KEY") {
		t.Fatalf("pairing code lookup plan: %s", plan)
	}
}
