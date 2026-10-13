package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/kaanemec/cross-tab-sync/server/internal/session"
)

const day = 24 * time.Hour

// historyFixture is a store with one owner device a at generation gen.
type historyFixture struct {
	t   *testing.T
	st  *Store
	dev string
	gen int64
	n   int
}

func newHistoryFixture(t *testing.T) *historyFixture {
	t.Helper()
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "cts.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	now := time.Now()
	code, _, err := st.CreatePairingCode(ctx, "", now)
	if err != nil {
		t.Fatal(err)
	}
	dev, _, err := st.Pair(ctx, code, "A", "brave", now)
	if err != nil {
		t.Fatal(err)
	}
	gen, _, err := st.Acquire(ctx, dev, false, now, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return &historyFixture{t: t, st: st, dev: dev, gen: gen}
}

func (f *historyFixture) id() string {
	f.n++
	return fmt.Sprintf("00000000-0000-4000-8000-%012x", f.n)
}

func (f *historyFixture) apply(at time.Time, ops ...session.Op) BatchResult {
	f.t.Helper()
	res, err := f.st.ApplyOperations(context.Background(), f.dev, f.gen, 0, ops, at, 5)
	if err != nil {
		f.t.Fatal(err)
	}
	return res
}

func (f *historyFixture) count(query string) int {
	f.t.Helper()
	var n int
	if err := f.st.db.QueryRowContext(context.Background(), query).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func TestPruneKeepsOpenEntriesAndAdvancesMinRevision(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	f := newHistoryFixture(t)
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	keep, gone, late := f.id(), f.id(), f.id()

	f.apply(t0,
		session.Op{OpID: f.id(), Type: session.TypeOpen, EntryID: keep, URL: "https://keep.example/"}, // 1
		session.Op{OpID: f.id(), Type: session.TypeOpen, EntryID: gone, URL: "https://gone.example/"}, // 2
		session.Op{OpID: f.id(), Type: session.TypeClose, EntryID: gone},                              // 3
		session.Op{OpID: f.id(), Type: session.TypeClose, EntryID: f.id()},                            // ignored
	)
	f.apply(t0.Add(20*day), session.Op{OpID: f.id(), Type: session.TypeOpen, EntryID: late, URL: "https://late.example/"}) // 4

	if sess, err := f.st.GetSession(ctx); err != nil || sess.MinRevision != 1 {
		t.Fatalf("before pruning: minRevision %d %v", sess.MinRevision, err)
	}
	// Nothing is older than 30 days yet.
	if res, err := f.st.Prune(ctx, t0.Add(25*day), 30*day); err != nil || res != (PruneResult{MinRevision: 1}) {
		t.Fatalf("early prune: %+v %v", res, err)
	}

	res, err := f.st.Prune(ctx, t0.Add(31*day), 30*day)
	if err != nil {
		t.Fatal(err)
	}
	if res != (PruneResult{Operations: 4, Tombstones: 1, MinRevision: 4}) {
		t.Fatalf("prune: %+v", res)
	}
	sess, err := f.st.GetSession(ctx)
	if err != nil || sess.MinRevision != 4 || sess.Revision != 4 || len(sess.Entries) != 2 {
		t.Fatalf("session after prune: %+v %v", sess, err)
	}
	if n := f.count(`SELECT COUNT(*) FROM entries`); n != 2 {
		t.Fatalf("entries rows %d, want the 2 open ones", n)
	}
	if _, err := f.st.Changes(ctx, 2); !errors.Is(err, ErrHistoryExpired) {
		t.Fatalf("changes since 2: %v", err)
	}
	if cs, err := f.st.Changes(ctx, 3); err != nil || cs.MinRevision != 4 || len(cs.Operations) != 1 || cs.Operations[0].Seq != 4 {
		t.Fatalf("changes since 3: %+v %v", cs, err)
	}

	// Everything expired: minRevision moves past the revision, and never back.
	if res, err := f.st.Prune(ctx, t0.Add(60*day), 30*day); err != nil || res.MinRevision != 5 || res.Operations != 1 {
		t.Fatalf("full prune: %+v %v", res, err)
	}
	if res, err := f.st.Prune(ctx, t0, 30*day); err != nil || res.MinRevision != 5 {
		t.Fatalf("clock moved back: %+v %v", res, err)
	}
	if sess, err := f.st.GetSession(ctx); err != nil || len(sess.Entries) != 2 {
		t.Fatalf("open entries must survive: %+v %v", sess, err)
	}
	if cs, err := f.st.Changes(ctx, 4); err != nil || len(cs.Operations) != 0 {
		t.Fatalf("changes at revision: %+v %v", cs, err)
	}
}

func TestPruneKeepsLogContiguous(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	f := newHistoryFixture(t)
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	f.apply(t0, session.Op{OpID: f.id(), Type: session.TypeOpen, EntryID: f.id(), URL: "https://a.example/"})             // 1
	f.apply(t0.Add(40*day), session.Op{OpID: f.id(), Type: session.TypeOpen, EntryID: f.id(), URL: "https://b.example/"}) // 2
	// The clock went backwards: revision 3 looks older than revision 2.
	f.apply(t0, session.Op{OpID: f.id(), Type: session.TypeOpen, EntryID: f.id(), URL: "https://c.example/"}) // 3

	res, err := f.st.Prune(ctx, t0.Add(45*day), 30*day)
	if err != nil || res.MinRevision != 2 || res.Operations != 1 {
		t.Fatalf("prune: %+v %v", res, err)
	}
	if cs, err := f.st.Changes(ctx, 1); err != nil || len(cs.Operations) != 2 {
		t.Fatalf("retained log must be contiguous: %+v %v", cs, err)
	}
}

func TestRunPrunerStopsOnCancel(t *testing.T) {
	t.Parallel()
	f := newHistoryFixture(t)
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	f.apply(t0, session.Op{OpID: f.id(), Type: session.TypeOpen, EntryID: f.id(), URL: "https://a.example/"})

	var (
		mu  sync.Mutex
		now = t0
	)
	clock := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	ticks := make(chan time.Time) // unbuffered: a send returns once the loop waits again
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		f.st.RunPruner(ctx, ticks, 30*day, clock, slog.New(slog.NewTextHandler(io.Discard, nil)))
	}()

	ticks <- t0 // startup pass done, nothing pruned
	if n := f.count(`SELECT COUNT(*) FROM operations`); n != 1 {
		t.Fatalf("startup pass pruned fresh history: %d ops", n)
	}
	mu.Lock()
	now = t0.Add(31 * day)
	mu.Unlock()
	ticks <- now // triggers the hourly pass
	ticks <- now // returns only after that pass finished
	if n := f.count(`SELECT COUNT(*) FROM operations`); n != 0 {
		t.Fatalf("hourly pass left %d ops", n)
	}

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("pruner did not stop after cancel")
	}
	select {
	case ticks <- now:
		t.Fatal("stopped pruner received a tick")
	default:
	}
}

func TestMigration0002Backfill(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "cts.db")

	// A v0.x database: only migration 1 applied, one entry updated at revision 7.
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	body, err := migrationFS.ReadFile("migrations/0001_init.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`,
		string(body),
		`INSERT INTO schema_migrations VALUES (1, 0)`,
		`INSERT INTO entries (id, url, opened_by, created_revision, updated_revision) VALUES ('e', 'https://a.example/', 'd', 3, 7)`,
		`UPDATE session SET revision = 7`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	st, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	var (
		urlRev int64
		urlDev string
	)
	if err := st.db.QueryRowContext(ctx, `SELECT url_revision, url_device FROM entries WHERE id = 'e'`).Scan(&urlRev, &urlDev); err != nil {
		t.Fatal(err)
	}
	if urlRev != 7 || urlDev != "" {
		t.Fatalf("backfill: url_revision %d url_device %q", urlRev, urlDev)
	}
	if sess, err := st.GetSession(ctx); err != nil || sess.MinRevision != 1 || sess.Revision != 7 {
		t.Fatalf("session after migration: %+v %v", sess, err)
	}
}

// A failure partway through a merge batch rolls back every earlier change.
func TestMergeFailureRollsBack(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	f := newHistoryFixture(t)
	now := time.Now()
	e1 := f.id()
	f.apply(now, session.Op{OpID: f.id(), Type: session.TypeOpen, EntryID: e1, URL: "https://a.example/"}) // 1

	// Valid at the API level, rejected by the database on the third op.
	if _, err := f.st.db.ExecContext(ctx, `CREATE TRIGGER fail_merge BEFORE INSERT ON entries
		WHEN NEW.url = 'https://fail.example/' BEGIN SELECT RAISE(ABORT, 'injected'); END`); err != nil {
		t.Fatal(err)
	}
	base := func(v int64) *int64 { return &v }
	ops := []session.MergeOp{
		{Op: session.Op{OpID: f.id(), Type: session.TypeOpen, EntryID: f.id(), URL: "https://b.example/"}, BaseRevision: base(1)},
		{Op: session.Op{OpID: f.id(), Type: session.TypeNavigate, EntryID: e1, URL: "https://a2.example/"}, BaseRevision: base(1)},
		{Op: session.Op{OpID: f.id(), Type: session.TypeOpen, EntryID: f.id(), URL: "https://fail.example/"}, BaseRevision: base(1)},
	}
	if _, err := f.st.Merge(ctx, f.dev, ops, now, 5); err == nil {
		t.Fatal("merge succeeded despite the injected failure")
	}
	sess, err := f.st.GetSession(ctx)
	if err != nil || sess.Revision != 1 || len(sess.Entries) != 1 || sess.Entries[0].URL != "https://a.example/" {
		t.Fatalf("session after failed merge: %+v %v", sess, err)
	}
	for query, want := range map[string]int{
		`SELECT COUNT(*) FROM operations`: 1,
		`SELECT COUNT(*) FROM entries`:    1,
		`SELECT COUNT(*) FROM snapshots`:  0,
	} {
		if n := f.count(query); n != want {
			t.Fatalf("%s = %d, want %d", query, n, want)
		}
	}
}
