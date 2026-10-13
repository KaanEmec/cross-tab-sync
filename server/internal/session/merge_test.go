package session

import (
	"slices"
	"testing"

	"github.com/google/uuid"
)

const (
	op3 = "00000000-0000-4000-8000-000000000003"
	e4  = "10000000-0000-4000-8000-000000000004"
)

// mergeFixture: e1's URL changed at revision 5 by another device, e2's URL at
// 2 (metadata later, at 6), e3 is a tombstone.
func mergeFixture() []Entry {
	return []Entry{
		{ID: e1, URL: "https://a.example/", URLRevision: 5, URLDevice: "other", UpdatedRevision: 5},
		{ID: e2, URL: "https://b.example/", Position: 1, URLRevision: 2, URLDevice: "other", UpdatedRevision: 6},
		{ID: e3, URL: "https://t.example/", Position: 2, URLRevision: 1, UpdatedRevision: 4, ClosedRevision: ptr(int64(4))},
	}
}

func openURLs(s *State) []string {
	var out []string
	for _, e := range s.OpenEntries() {
		out = append(out, e.URL)
	}
	slices.Sort(out)
	return out
}

// TestMergeRules covers every cell of the merge-rules table. "unchanged" uses
// base 5 (e1 not navigated since), "navigated" base 4, "expired" base 5 with
// the history flag set.
func TestMergeRules(t *testing.T) {
	t.Parallel()
	const (
		a, b, c, x = "https://a.example/", "https://b.example/", "https://c.example/", "https://x.example/"
	)
	forked := ForkedEntryID(op1)
	tests := []struct {
		name    string
		op      Op
		base    int64
		expired bool
		status  string
		entryID string
		urls    []string // open URLs afterwards
	}{
		{"open fresh/unchanged", Op{OpID: op1, Type: TypeOpen, EntryID: e4, URL: c}, 5, false, StatusApplied, e4, []string{a, b, c}},
		{"open fresh/navigated", Op{OpID: op1, Type: TypeOpen, EntryID: e4, URL: c}, 4, false, StatusApplied, e4, []string{a, b, c}},
		{"open fresh/expired", Op{OpID: op1, Type: TypeOpen, EntryID: e4, URL: c}, 5, true, StatusApplied, e4, []string{a, b, c}},
		{"open same url/unchanged", Op{OpID: op1, Type: TypeOpen, EntryID: e4, URL: a}, 5, false, StatusCoalesced, e1, []string{a, b}},
		{"open same url/navigated", Op{OpID: op1, Type: TypeOpen, EntryID: e4, URL: a}, 4, false, StatusCoalesced, e1, []string{a, b}},
		{"open tombstone/unchanged", Op{OpID: op1, Type: TypeOpen, EntryID: e3, URL: x}, 5, false, StatusIgnored, "", []string{a, b}},
		{"open tombstone/expired", Op{OpID: op1, Type: TypeOpen, EntryID: e3, URL: x}, 0, true, StatusIgnored, "", []string{a, b}},

		{"navigate/unchanged", Op{OpID: op1, Type: TypeNavigate, EntryID: e1, URL: c}, 5, false, StatusApplied, e1, []string{b, c}},
		{"navigate/navigated", Op{OpID: op1, Type: TypeNavigate, EntryID: e1, URL: c}, 4, false, StatusForked, forked, []string{a, b, c}},
		{"navigate/expired", Op{OpID: op1, Type: TypeNavigate, EntryID: e1, URL: c}, 5, true, StatusForked, forked, []string{a, b, c}},
		{"navigate/navigated onto open url", Op{OpID: op1, Type: TypeNavigate, EntryID: e1, URL: b}, 4, false, StatusCoalesced, e2, []string{a, b}},
		{"navigate/tombstone", Op{OpID: op1, Type: TypeNavigate, EntryID: e3, URL: c}, 0, true, StatusIgnored, "", []string{a, b}},

		{"close/unchanged", Op{OpID: op1, Type: TypeClose, EntryID: e1}, 5, false, StatusApplied, e1, []string{b}},
		{"close/navigated", Op{OpID: op1, Type: TypeClose, EntryID: e1}, 4, false, StatusIgnored, "", []string{a, b}},
		{"close/expired", Op{OpID: op1, Type: TypeClose, EntryID: e1}, 5, true, StatusIgnored, "", []string{a, b}},
		{"close/metadata changed since", Op{OpID: op1, Type: TypeClose, EntryID: e2}, 2, false, StatusApplied, e2, []string{a}},
		{"close/unknown entry", Op{OpID: op1, Type: TypeClose, EntryID: e4}, 5, false, StatusIgnored, "", []string{a, b}},

		{"update/unchanged", Op{OpID: op1, Type: TypeUpdate, EntryID: e1, Pinned: ptr(true)}, 5, false, StatusApplied, e1, []string{a, b}},
		{"update/navigated", Op{OpID: op1, Type: TypeUpdate, EntryID: e1, Pinned: ptr(true)}, 4, false, StatusIgnored, "", []string{a, b}},
		{"update/expired", Op{OpID: op1, Type: TypeUpdate, EntryID: e1, Pinned: ptr(true)}, 5, true, StatusIgnored, "", []string{a, b}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			s := NewState(mergeFixture())
			res, changed, logged := s.Merge(tt.op, tt.base, tt.expired, "dev", 10)
			if res.Status != tt.status || res.EntryID != tt.entryID || res.OpID != op1 {
				t.Fatalf("result %+v, want %s %s", res, tt.status, tt.entryID)
			}
			if got := openURLs(s); !slices.Equal(got, tt.urls) {
				t.Fatalf("open urls %v, want %v", got, tt.urls)
			}
			if (changed == nil) != (tt.status == StatusIgnored || tt.status == StatusCoalesced) {
				t.Fatalf("changed entry %+v for status %s", changed, res.Status)
			}
			wantLogged := tt.op
			if tt.op.Type == TypeNavigate && (tt.expired || tt.base < 5) && tt.status != StatusIgnored {
				// Converted to an open of the fork, logged as such.
				wantLogged = Op{OpID: op1, Type: TypeOpen, EntryID: forked, URL: tt.op.URL}
			}
			if tt.status == StatusForked && (changed.ID != forked || changed.URLRevision != 10 || changed.URLDevice != "dev") {
				t.Fatalf("forked entry %+v", changed)
			}
			if logged.OpID != wantLogged.OpID || logged.Type != wantLogged.Type || logged.EntryID != wantLogged.EntryID || logged.URL != wantLogged.URL {
				t.Fatalf("logged op %+v, want %+v", logged, wantLogged)
			}
		})
	}
}

func TestMergeOwnURLChangesDoNotBlock(t *testing.T) {
	t.Parallel()
	// e1's URL changed at 5 by this very device (an earlier batch of its
	// journal); its later operations recorded at base 2 still apply.
	s := NewState([]Entry{{ID: e1, URL: "https://a.example/", URLRevision: 5, URLDevice: "dev"}})
	r, _, _ := s.Merge(Op{OpID: op1, Type: TypeNavigate, EntryID: e1, URL: "https://b.example/"}, 2, false, "dev", 6)
	if r.Status != StatusApplied || r.EntryID != e1 {
		t.Fatalf("own navigate: %+v", r)
	}
	r, _, _ = s.Merge(Op{OpID: op2, Type: TypeClose, EntryID: e1}, 2, false, "dev", 7)
	if r.Status != StatusApplied {
		t.Fatalf("own close: %+v", r)
	}
	// Expired history wins over ownership of the change.
	s = NewState([]Entry{{ID: e1, URL: "https://a.example/", URLRevision: 5, URLDevice: "dev"}})
	if r, _, _ := s.Merge(Op{OpID: op1, Type: TypeClose, EntryID: e1}, 2, true, "dev", 6); r.Status != StatusIgnored {
		t.Fatalf("expired close: %+v", r)
	}
}

func TestMergeRedirectsLaterOpsToFork(t *testing.T) {
	t.Parallel()
	s := NewState([]Entry{{ID: e1, URL: "https://a.example/", Pinned: true, URLRevision: 5, URLDevice: "other"}})
	forked := ForkedEntryID(op1)

	r, ch, _ := s.Merge(Op{OpID: op1, Type: TypeNavigate, EntryID: e1, URL: "https://b.example/"}, 4, false, "dev", 6)
	if r.Status != StatusForked || r.EntryID != forked || !ch.Pinned {
		t.Fatalf("fork: %+v %+v", r, ch)
	}
	// The same journal keeps addressing e1; those ops now mean the fork.
	r, _, logged := s.Merge(Op{OpID: op2, Type: TypeNavigate, EntryID: e1, URL: "https://c.example/"}, 4, false, "dev", 7)
	if r.Status != StatusApplied || r.EntryID != forked || logged.EntryID != forked {
		t.Fatalf("redirected navigate: %+v %+v", r, logged)
	}
	if got := openURLs(s); !slices.Equal(got, []string{"https://a.example/", "https://c.example/"}) {
		t.Fatalf("open urls %v", got)
	}
	r, _, _ = s.Merge(Op{OpID: op3, Type: TypeClose, EntryID: e1}, 4, false, "dev", 8)
	if r.Status != StatusApplied || r.EntryID != forked {
		t.Fatalf("redirected close: %+v", r)
	}
	if got := openURLs(s); !slices.Equal(got, []string{"https://a.example/"}) {
		t.Fatalf("other device's entry must survive: %v", got)
	}
}

func TestForkedEntryID(t *testing.T) {
	t.Parallel()
	id := ForkedEntryID(op1)
	if id != ForkedEntryID(op1) || id == ForkedEntryID(op2) || !IsUUID(id) {
		t.Fatalf("ForkedEntryID(%s) = %s", op1, id)
	}
	if u := uuid.MustParse(id); u.Version() != 5 {
		t.Fatalf("version %d", u.Version())
	}
	// A fork that already exists as a tombstone (opId pruned and resent) stays closed.
	s := NewState([]Entry{
		{ID: e1, URL: "https://a.example/", URLRevision: 5, URLDevice: "other"},
		{ID: id, URL: "https://b.example/", ClosedRevision: ptr(int64(3))},
	})
	if r, _, _ := s.Merge(Op{OpID: op1, Type: TypeNavigate, EntryID: e1, URL: "https://b.example/"}, 1, false, "dev", 6); r.Status != StatusIgnored {
		t.Fatalf("tombstoned fork reopened: %+v", r)
	}
}

// A journal replayed with an expired base (the recovery path after 410) must
// not treat entries its own batch opened, navigated or forked as moved.
func TestMergeExpiredBaseKeepsOwnBatchChanges(t *testing.T) {
	t.Parallel()
	s := NewState(nil)
	for i, op := range []Op{
		{OpID: op1, Type: TypeOpen, EntryID: e1, URL: "https://a.example/"},
		{OpID: op2, Type: TypeNavigate, EntryID: e1, URL: "https://b.example/"},
		{OpID: op3, Type: TypeClose, EntryID: e1},
	} {
		if r, _, _ := s.Merge(op, 0, true, "dev", int64(i+1)); r.Status != StatusApplied || r.EntryID != e1 {
			t.Fatalf("op %d: %+v", i, r)
		}
	}
	if got := openURLs(s); len(got) != 0 {
		t.Fatalf("left open: %v", got)
	}

	// Fork, then close on the fork (addressed through the original id), in one batch.
	s = NewState([]Entry{
		{ID: e2, URL: "https://x.example/", URLRevision: 3, URLDevice: "other"},
		{ID: e3, URL: "https://z.example/", Position: 1, URLRevision: 3, URLDevice: "other"},
	})
	forked := ForkedEntryID(op1)
	if r, _, _ := s.Merge(Op{OpID: op1, Type: TypeNavigate, EntryID: e2, URL: "https://y.example/"}, 0, true, "dev", 10); r.Status != StatusForked {
		t.Fatalf("fork: %+v", r)
	}
	if r, _, _ := s.Merge(Op{OpID: op2, Type: TypeClose, EntryID: e2}, 0, true, "dev", 11); r.Status != StatusApplied || r.EntryID != forked {
		t.Fatalf("close on fork: %+v", r)
	}
	if got := openURLs(s); !slices.Equal(got, []string{"https://x.example/", "https://z.example/"}) {
		t.Fatalf("open urls %v", got)
	}
	// Entries the batch did not touch stay protected by the expired rule.
	if r, _, _ := s.Merge(Op{OpID: op3, Type: TypeClose, EntryID: e3}, 0, true, "dev", 12); r.Status != StatusIgnored {
		t.Fatalf("close on untouched entry: %+v", r)
	}
}
