package session

import (
	"errors"
	"strings"
	"testing"
)

const (
	op1 = "00000000-0000-4000-8000-000000000001"
	op2 = "00000000-0000-4000-8000-000000000002"
	e1  = "10000000-0000-4000-8000-000000000001"
	e2  = "10000000-0000-4000-8000-000000000002"
	e3  = "10000000-0000-4000-8000-000000000003"
)

func ptr[T any](v T) *T { return &v }

func TestValidate(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		op   Op
		ok   bool
	}{
		{"open", Op{OpID: op1, Type: TypeOpen, EntryID: e1, URL: "https://a.example/x?q=1#f"}, true},
		{"close", Op{OpID: op1, Type: TypeClose, EntryID: e1}, true},
		{"update pinned", Op{OpID: op1, Type: TypeUpdate, EntryID: e1, Pinned: ptr(true)}, true},
		{"update empty", Op{OpID: op1, Type: TypeUpdate, EntryID: e1}, false},
		{"uppercase uuid", Op{OpID: "AAAAAAAA-0000-4000-8000-00000000000A", Type: TypeClose, EntryID: e1}, false},
		{"bad entry id", Op{OpID: op1, Type: TypeClose, EntryID: "x"}, false},
		{"unknown type", Op{OpID: op1, Type: "reload", EntryID: e1}, false},
		{"file url", Op{OpID: op1, Type: TypeOpen, EntryID: e1, URL: "file:///etc/passwd"}, false},
		{"relative url", Op{OpID: op1, Type: TypeOpen, EntryID: e1, URL: "/x"}, false},
		{"long url", Op{OpID: op1, Type: TypeOpen, EntryID: e1, URL: "https://a.example/" + strings.Repeat("a", MaxURLBytes)}, false},
		{"negative position", Op{OpID: op1, Type: TypeOpen, EntryID: e1, URL: "https://a.example/", Position: ptr(int64(-1))}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			err := Validate(tt.op)
			if (err == nil) != tt.ok {
				t.Fatalf("Validate() = %v, want ok=%v", err, tt.ok)
			}
			if err != nil && !errors.Is(err, ErrInvalid) {
				t.Fatalf("error does not wrap ErrInvalid: %v", err)
			}
		})
	}
}

func TestApplyOpenCoalescesOnExactURL(t *testing.T) {
	t.Parallel()
	s := NewState(nil)
	r, ch := s.Apply(Op{OpID: op1, Type: TypeOpen, EntryID: e1, URL: "https://a.example/"}, "dev", 1)
	if r.Status != StatusApplied || r.EntryID != e1 || ch == nil || ch.Position != 0 {
		t.Fatalf("first open: %+v %+v", r, ch)
	}
	r, ch = s.Apply(Op{OpID: op2, Type: TypeOpen, EntryID: e2, URL: "https://a.example/"}, "dev", 2)
	if r.Status != StatusCoalesced || r.EntryID != e1 || ch != nil {
		t.Fatalf("duplicate open: %+v %+v", r, ch)
	}
	// Different query string is a different URL.
	r, ch = s.Apply(Op{OpID: op2, Type: TypeOpen, EntryID: e2, URL: "https://a.example/?a"}, "dev", 2)
	if r.Status != StatusApplied || ch.Position != 1 {
		t.Fatalf("distinct url: %+v %+v", r, ch)
	}
	if got := len(s.OpenEntries()); got != 2 {
		t.Fatalf("open entries = %d", got)
	}
}

func TestApplyNavigateCollisionClosesEntry(t *testing.T) {
	t.Parallel()
	s := NewState([]Entry{
		{ID: e1, URL: "https://a.example/"},
		{ID: e2, URL: "https://b.example/", Position: 1},
	})
	r, ch := s.Apply(Op{OpID: op1, Type: TypeNavigate, EntryID: e2, URL: "https://a.example/"}, "dev", 5)
	if r.Status != StatusCoalesced || r.EntryID != e1 {
		t.Fatalf("result %+v", r)
	}
	if ch == nil || ch.ID != e2 || ch.Open() || *ch.ClosedRevision != 5 {
		t.Fatalf("changed %+v", ch)
	}
	open := s.OpenEntries()
	if len(open) != 1 || open[0].ID != e1 {
		t.Fatalf("open %+v", open)
	}

	// Plain navigate updates the URL and frees the old one.
	r, ch = s.Apply(Op{OpID: op2, Type: TypeNavigate, EntryID: e1, URL: "https://c.example/"}, "dev", 6)
	if r.Status != StatusApplied || ch.URL != "https://c.example/" || ch.UpdatedRevision != 6 {
		t.Fatalf("navigate %+v %+v", r, ch)
	}
	r, _ = s.Apply(Op{OpID: op2, Type: TypeOpen, EntryID: e3, URL: "https://a.example/"}, "dev", 7)
	if r.Status != StatusApplied {
		t.Fatalf("old url should be free: %+v", r)
	}
}

func TestApplyCloseTombstone(t *testing.T) {
	t.Parallel()
	s := NewState([]Entry{{ID: e1, URL: "https://a.example/"}})
	r, ch := s.Apply(Op{OpID: op1, Type: TypeClose, EntryID: e1}, "dev", 2)
	if r.Status != StatusApplied || ch.Open() {
		t.Fatalf("close %+v %+v", r, ch)
	}
	for _, op := range []Op{
		{OpID: op2, Type: TypeClose, EntryID: e1},
		{OpID: op2, Type: TypeNavigate, EntryID: e1, URL: "https://b.example/"},
		{OpID: op2, Type: TypeUpdate, EntryID: e1, Pinned: ptr(true)},
		{OpID: op2, Type: TypeOpen, EntryID: e1, URL: "https://a.example/"},
		{OpID: op2, Type: TypeClose, EntryID: e2},
	} {
		if r, ch := s.Apply(op, "dev", 3); r.Status != StatusIgnored || ch != nil {
			t.Errorf("%s on tombstone/unknown: %+v %+v", op.Type, r, ch)
		}
	}
	// The URL is free again under a new entry id.
	if r, _ := s.Apply(Op{OpID: op2, Type: TypeOpen, EntryID: e2, URL: "https://a.example/"}, "dev", 3); r.Status != StatusApplied {
		t.Fatalf("reopen under new id: %+v", r)
	}
}

func TestApplyUpdate(t *testing.T) {
	t.Parallel()
	s := NewState([]Entry{{ID: e1, URL: "https://a.example/"}, {ID: e2, URL: "https://b.example/", Position: 1}})
	r, ch := s.Apply(Op{OpID: op1, Type: TypeUpdate, EntryID: e1, Pinned: ptr(true), Position: ptr(int64(9))}, "dev", 3)
	if r.Status != StatusApplied || !ch.Pinned || ch.Position != 9 {
		t.Fatalf("update %+v %+v", r, ch)
	}
	open := s.OpenEntries()
	if open[0].ID != e2 || open[1].ID != e1 {
		t.Fatalf("sort order %+v", open)
	}
}
