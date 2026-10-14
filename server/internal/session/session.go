// Package session holds the operation semantics of the shared session.
// It is pure: the store loads the relevant entries, State applies operations
// in memory, and the store persists each changed entry.
package session

import (
	"errors"
	"fmt"
	"sort"

	"github.com/google/uuid"
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
	StatusForked    = "forked" // merge only: a stale navigate became an open
)

// Limits from PROTOCOL.md.
const (
	URLKeyLength  = 43 // base64url HMAC-SHA256, unpadded
	MaxURLEncLen  = 4096
	MaxBatchOps   = 500
	MaxBodyBytes  = 256 << 10
	MaxNameLength = 64
	MaxPosition   = 1<<53 - 1 // largest integer JavaScript represents exactly
)

// Op is one client operation as sent on the wire and stored in the log.
type Op struct {
	OpID     string `json:"opId"`
	Type     string `json:"type"`
	EntryID  string `json:"entryId"`
	URLKey   string `json:"urlKey,omitempty"`
	URLEnc   string `json:"urlEnc,omitempty"`
	Pinned   *bool  `json:"pinned,omitempty"`
	Position *int64 `json:"position,omitempty"`
}

// MergeOp is an offline operation submitted through merge, carrying the
// revision the device had applied when it recorded the change.
type MergeOp struct {
	Op
	BaseRevision *int64 `json:"baseRevision"`
}

// Result is the stored outcome of an operation.
type Result struct {
	OpID     string `json:"opId"`
	Status   string `json:"status"`
	EntryID  string `json:"entryId,omitempty"`
	Replayed bool   `json:"replayed,omitempty"`
}

// Entry is one shared tab, open or closed (tombstone). The URL is end-to-end
// encrypted: URLKey is its keyed hash (identity for coalescing) and URLEnc
// its ciphertext, both opaque to the server.
type Entry struct {
	ID              string
	URLKey          string
	URLEnc          string
	Pinned          bool
	Position        int64
	OpenedBy        string
	CreatedRevision int64
	UpdatedRevision int64
	ClosedRevision  *int64
	URLRevision     int64  // revision of the last URL change (open or navigate)
	URLDevice       string // device that made that change; "" when unknown
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
		if err := ValidateURLFields(op.URLKey, op.URLEnc); err != nil {
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

// ValidateURLFields checks the shape of an encrypted URL: urlKey exactly
// URLKeyLength and urlEnc 1..MaxURLEncLen base64url characters. Neither is
// decoded; the server does no cryptography.
func ValidateURLFields(key, enc string) error {
	if len(key) != URLKeyLength || !isBase64URL(key) {
		return fmt.Errorf("%w: urlKey must be %d base64url characters", ErrInvalid, URLKeyLength)
	}
	if enc == "" || len(enc) > MaxURLEncLen || !isBase64URL(enc) {
		return fmt.Errorf("%w: urlEnc must be 1..%d base64url characters", ErrInvalid, MaxURLEncLen)
	}
	return nil
}

// isBase64URL reports whether s uses only the unpadded base64url alphabet.
func isBase64URL(s string) bool {
	for i := range len(s) {
		c := s[i]
		if (c < 'A' || c > 'Z') && (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' && c != '_' {
			return false
		}
	}
	return true
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
	openByKey map[string]string // urlKey -> open entry id
	forks     map[string]string // merge: entry id -> entry forked from it in this batch
	ownURLs   map[string]bool   // entries whose URL this batch set (open or navigate)
	nextPos   int64
}

// NewState builds a state from entries; it copies them.
func NewState(entries []Entry) *State {
	s := &State{byID: make(map[string]*Entry, len(entries)), openByKey: make(map[string]string),
		forks: make(map[string]string), ownURLs: make(map[string]bool)}
	for i := range entries {
		e := entries[i]
		s.byID[e.ID] = &e
		if e.Open() {
			s.openByKey[e.URLKey] = e.ID
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
		if id, ok := s.openByKey[op.URLKey]; ok {
			res.Status, res.EntryID = StatusCoalesced, id
			return res, nil
		}
		ne := &Entry{
			ID: op.EntryID, URLKey: op.URLKey, URLEnc: op.URLEnc, OpenedBy: deviceID,
			CreatedRevision: rev, UpdatedRevision: rev, Position: s.nextPos,
			URLRevision: rev, URLDevice: deviceID,
		}
		if op.Pinned != nil {
			ne.Pinned = *op.Pinned
		}
		if op.Position != nil {
			ne.Position = *op.Position
		}
		s.byID[ne.ID] = ne
		s.openByKey[ne.URLKey] = ne.ID
		s.ownURLs[ne.ID] = true
		s.nextPos = min(max(s.nextPos, ne.Position+1), MaxPosition)
		res.Status, res.EntryID = StatusApplied, ne.ID
		return res, copyEntry(ne)

	case TypeNavigate:
		if e == nil || !e.Open() {
			return res, nil
		}
		if other, ok := s.openByKey[op.URLKey]; ok && other != e.ID {
			s.closeEntry(e, rev)
			res.Status, res.EntryID = StatusCoalesced, other
			return res, copyEntry(e)
		}
		// Only a key change moves the entry ("navigated since"); the same
		// URL sealed again just refreshes the ciphertext.
		if e.URLKey != op.URLKey {
			delete(s.openByKey, e.URLKey)
			e.URLKey = op.URLKey
			e.URLRevision, e.URLDevice = rev, deviceID
			s.openByKey[e.URLKey] = e.ID
		}
		e.URLEnc = op.URLEnc
		e.UpdatedRevision = rev
		s.ownURLs[e.ID] = true
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

// ForkedEntryID is the entry id a forked navigate opens: the UUIDv5 (SHA-1)
// of the name "forked" in the namespace of the operation id. It is stable, so
// a navigate resubmitted after its opId was pruned coalesces with (or, as a
// tombstone, is ignored by) its earlier fork, as long as that entry is
// retained; once a closed fork is pruned, a resubmission opens it again.
func ForkedEntryID(opID string) string {
	return uuid.NewSHA1(uuid.MustParse(opID), []byte("forked")).String()
}

// Merge applies an offline operation recorded at baseRevision, following the
// merge rules. An existing open entry counts as moved when its URL changed
// after baseRevision through another device, or always when expired is set
// (baseRevision outside the retained history), except entries whose URL this
// batch itself set: the journal's own opens, navigates and forks. A navigate on a moved entry
// opens a fresh entry (StatusForked, coalescing on urlKey); close and update on a
// moved entry are ignored; open behaves as in Apply. Later operations of the
// same batch on a forked entry are redirected to its fork.
//
// The returned Op is the operation as effectively applied (a forked navigate
// becomes its open, redirected operations carry the fork's id); the log
// stores it so followers replay the merge correctly.
func (s *State) Merge(op Op, baseRevision int64, expired bool, deviceID string, rev int64) (Result, *Entry, Op) {
	if op.Type == TypeOpen {
		res, changed := s.Apply(op, deviceID, rev)
		return res, changed, op
	}
	from := op.EntryID
	if id, ok := s.forks[from]; ok {
		op.EntryID = id
	}
	e := s.byID[op.EntryID]
	moved := e != nil && e.Open() && !s.ownURLs[e.ID] &&
		(expired || (e.URLRevision > baseRevision && e.URLDevice != deviceID))
	if !moved {
		res, changed := s.Apply(op, deviceID, rev)
		return res, changed, op
	}
	if op.Type != TypeNavigate {
		return Result{OpID: op.OpID, Status: StatusIgnored}, nil, op
	}
	pinned := e.Pinned
	fork := Op{OpID: op.OpID, Type: TypeOpen, EntryID: ForkedEntryID(op.OpID),
		URLKey: op.URLKey, URLEnc: op.URLEnc, Pinned: &pinned}
	res, changed := s.Apply(fork, deviceID, rev)
	if res.Status == StatusApplied {
		res.Status = StatusForked
		s.forks[from] = fork.EntryID
	}
	return res, changed, fork
}

func (s *State) closeEntry(e *Entry, rev int64) {
	delete(s.openByKey, e.URLKey)
	r := rev
	e.ClosedRevision = &r
	e.UpdatedRevision = rev
}

// OpenEntries returns the open entries sorted by position then id.
func (s *State) OpenEntries() []Entry {
	out := make([]Entry, 0, len(s.openByKey))
	for _, id := range s.openByKey {
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
