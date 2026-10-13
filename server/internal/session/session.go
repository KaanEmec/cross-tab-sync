// Package session holds the operation semantics of the shared session.
// It is pure: the store loads the relevant entries, State applies operations
// in memory, and the store persists each changed entry.
package session

import (
	"errors"
	"fmt"
	"net/url"
	"sort"
)

// Operation types.
const (
	TypeOpen     = "open"
	TypeNavigate = "navigate"
	TypeClose    = "close"
	TypeUpdate   = "update"
)

// Result statuses.
const (
	StatusApplied   = "applied"
	StatusCoalesced = "coalesced"
	StatusIgnored   = "ignored"
)

// Limits from PROTOCOL.md.
const (
	MaxURLBytes   = 2048
	MaxBatchOps   = 500
	MaxBodyBytes  = 64 << 10
	MaxNameLength = 64
	MaxPosition   = 1<<53 - 1 // largest integer JavaScript represents exactly
)

// Op is one client operation as sent on the wire and stored in the log.
type Op struct {
	OpID     string `json:"opId"`
	Type     string `json:"type"`
	EntryID  string `json:"entryId"`
	URL      string `json:"url,omitempty"`
	Pinned   *bool  `json:"pinned,omitempty"`
	Position *int64 `json:"position,omitempty"`
}

// Result is the stored outcome of an operation.
type Result struct {
	OpID     string `json:"opId"`
	Status   string `json:"status"`
	EntryID  string `json:"entryId,omitempty"`
	Replayed bool   `json:"replayed,omitempty"`
}

// Entry is one shared tab, open or closed (tombstone).
type Entry struct {
	ID              string
	URL             string
	Pinned          bool
	Position        int64
	OpenedBy        string
	CreatedRevision int64
	UpdatedRevision int64
	ClosedRevision  *int64
}

// Open reports whether the entry is not a tombstone.
func (e *Entry) Open() bool { return e.ClosedRevision == nil }

// ErrInvalid wraps every validation failure.
var ErrInvalid = errors.New("invalid operation")

// Validate checks the shape of an operation without looking at state.
func Validate(op Op) error {
	if !IsUUID(op.OpID) {
		return fmt.Errorf("%w: opId must be a lowercase UUID", ErrInvalid)
	}
	if !IsUUID(op.EntryID) {
		return fmt.Errorf("%w: entryId must be a lowercase UUID", ErrInvalid)
	}
	if op.Position != nil && (*op.Position < 0 || *op.Position > MaxPosition) {
		return fmt.Errorf("%w: position must be 0..2^53-1", ErrInvalid)
	}
	switch op.Type {
	case TypeOpen, TypeNavigate:
		if err := ValidateURL(op.URL); err != nil {
			return err
		}
	case TypeClose:
	case TypeUpdate:
		if op.Pinned == nil && op.Position == nil {
			return fmt.Errorf("%w: update needs pinned or position", ErrInvalid)
		}
	default:
		return fmt.Errorf("%w: unknown type", ErrInvalid)
	}
	return nil
}

// ValidateURL accepts absolute http and https URLs up to MaxURLBytes.
// The string is never normalized: identity is the exact string.
func ValidateURL(raw string) error {
	if raw == "" || len(raw) > MaxURLBytes {
		return fmt.Errorf("%w: url must be 1..%d bytes", ErrInvalid, MaxURLBytes)
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("%w: url must be an absolute http or https URL", ErrInvalid)
	}
	return nil
}

// IsUUID reports whether s is a canonical lowercase UUID (8-4-4-4-12 hex).
func IsUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i := range len(s) {
		c := s[i]
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
				return false
			}
		}
	}
	return true
}

// State is the in-memory view used while applying one batch. It must be
// built from every open entry plus any entry referenced by the batch.
type State struct {
	byID      map[string]*Entry
	openByURL map[string]string
	nextPos   int64
}

// NewState builds a state from entries; it copies them.
func NewState(entries []Entry) *State {
	s := &State{byID: make(map[string]*Entry, len(entries)), openByURL: make(map[string]string)}
	for i := range entries {
		e := entries[i]
		s.byID[e.ID] = &e
		if e.Open() {
			s.openByURL[e.URL] = e.ID
			s.nextPos = min(max(s.nextPos, e.Position+1), MaxPosition)
		}
	}
	return s
}

// Apply applies op at revision rev (the revision it takes unless ignored) and
// returns its result and the entry it changed, if any. The op must be valid.
func (s *State) Apply(op Op, deviceID string, rev int64) (Result, *Entry) {
	res := Result{OpID: op.OpID, Status: StatusIgnored}
	e := s.byID[op.EntryID]

	switch op.Type {
	case TypeOpen:
		if e != nil {
			if !e.Open() {
				return res, nil // tombstones are never reopened
			}
			res.Status, res.EntryID = StatusCoalesced, e.ID
			return res, nil
		}
		if id, ok := s.openByURL[op.URL]; ok {
			res.Status, res.EntryID = StatusCoalesced, id
			return res, nil
		}
		ne := &Entry{
			ID: op.EntryID, URL: op.URL, OpenedBy: deviceID,
			CreatedRevision: rev, UpdatedRevision: rev, Position: s.nextPos,
		}
		if op.Pinned != nil {
			ne.Pinned = *op.Pinned
		}
		if op.Position != nil {
			ne.Position = *op.Position
		}
		s.byID[ne.ID] = ne
		s.openByURL[ne.URL] = ne.ID
		s.nextPos = min(max(s.nextPos, ne.Position+1), MaxPosition)
		res.Status, res.EntryID = StatusApplied, ne.ID
		return res, copyEntry(ne)

	case TypeNavigate:
		if e == nil || !e.Open() {
			return res, nil
		}
		if other, ok := s.openByURL[op.URL]; ok && other != e.ID {
			s.closeEntry(e, rev)
			res.Status, res.EntryID = StatusCoalesced, other
			return res, copyEntry(e)
		}
		delete(s.openByURL, e.URL)
		e.URL = op.URL
		e.UpdatedRevision = rev
		s.openByURL[e.URL] = e.ID
		res.Status, res.EntryID = StatusApplied, e.ID
		return res, copyEntry(e)

	case TypeClose:
		if e == nil || !e.Open() {
			return res, nil
		}
		s.closeEntry(e, rev)
		res.Status, res.EntryID = StatusApplied, e.ID
		return res, copyEntry(e)

	case TypeUpdate:
		if e == nil || !e.Open() {
			return res, nil
		}
		if op.Pinned != nil {
			e.Pinned = *op.Pinned
		}
		if op.Position != nil {
			e.Position = *op.Position
			s.nextPos = min(max(s.nextPos, e.Position+1), MaxPosition)
		}
		e.UpdatedRevision = rev
		res.Status, res.EntryID = StatusApplied, e.ID
		return res, copyEntry(e)
	}
	return res, nil
}

func (s *State) closeEntry(e *Entry, rev int64) {
	delete(s.openByURL, e.URL)
	r := rev
	e.ClosedRevision = &r
	e.UpdatedRevision = rev
}

// OpenEntries returns the open entries sorted by position then id.
func (s *State) OpenEntries() []Entry {
	out := make([]Entry, 0, len(s.openByURL))
	for _, id := range s.openByURL {
		out = append(out, *s.byID[id])
	}
	SortEntries(out)
	return out
}

// SortEntries sorts by position then id, the order used on the wire.
func SortEntries(es []Entry) {
	sort.Slice(es, func(i, j int) bool {
		if es[i].Position != es[j].Position {
			return es[i].Position < es[j].Position
		}
		return es[i].ID < es[j].ID
	})
}

func copyEntry(e *Entry) *Entry {
	c := *e
	if e.ClosedRevision != nil {
		r := *e.ClosedRevision
		c.ClosedRevision = &r
	}
	return &c
}
