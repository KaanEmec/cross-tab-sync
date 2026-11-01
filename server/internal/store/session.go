package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/kaanemec/cross-tab-sync/server/internal/session"
)

// Snapshot reasons.
const (
	ReasonOperations = "operations" // before a batch with close or navigate
	ReasonRestore    = "restore"    // before restoring another snapshot
)

// Owner is the current session owner.
type Owner struct {
	DeviceID   string    `json:"deviceId"`
	Name       string    `json:"name"`
	Generation int64     `json:"generation"`
	LastSeenAt Timestamp `json:"lastSeenAt"`
}

// Session is the caller's session with its open entries.
type Session struct {
	Revision    int64
	MinRevision int64 // oldest retained operation sequence number
	KeyCheck    string
	Owner       *Owner
	Entries     []session.Entry
}

// ChangeSet is the answer to a changes request.
type ChangeSet struct {
	Revision    int64
	MinRevision int64
	Owner       *Owner
	Operations  []LoggedOp
}

// LoggedOp is one applied operation from the log.
type LoggedOp struct {
	Seq      int64           `json:"seq"`
	DeviceID string          `json:"deviceId"`
	Op       json.RawMessage `json:"op"`
	Result   json.RawMessage `json:"result"`
}

// BatchResult is the outcome of an operations batch, a merge or a restore.
type BatchResult struct {
	Revision   int64
	Results    []session.Result
	CatchUp    []LoggedOp
	FullResync bool // baseRevision is outside the retained history; CatchUp is empty
}

// Snapshot describes a stored recovery snapshot.
type Snapshot struct {
	ID         int64     `json:"id"`
	Revision   int64     `json:"revision"`
	DeviceID   string    `json:"deviceId"`
	Reason     string    `json:"reason"`
	CreatedAt  Timestamp `json:"createdAt"`
	EntryCount int       `json:"entryCount"`
}

type snapshotEntry struct {
	ID       string `json:"id"`
	URLKey   string `json:"urlKey"`
	URLEnc   string `json:"urlEnc"`
	Pinned   bool   `json:"pinned"`
	Position int64  `json:"position"`
}

type sessionRow struct {
	revision    int64
	minRevision int64
	generation  int64
	keyCheck    string
	owner       *Owner
}

// expired reports whether a client that has applied revision base cannot
// catch up from the retained history.
func (r sessionRow) expired(base int64) bool { return base < r.minRevision-1 }

func loadSession(ctx context.Context, tx *sql.Tx, sid int64) (sessionRow, error) {
	var (
		r        sessionRow
		ownerID  sql.NullString
		lastSeen sql.NullInt64
		name     sql.NullString
	)
	err := tx.QueryRowContext(ctx, `SELECT s.revision, s.min_revision, s.generation, s.owner_device_id, s.owner_last_seen_at, d.name,
		s.key_check FROM sessions s LEFT JOIN devices d ON d.id = s.owner_device_id WHERE s.id = ?`, sid).
		Scan(&r.revision, &r.minRevision, &r.generation, &ownerID, &lastSeen, &name, &r.keyCheck)
	if err != nil {
		return r, fmt.Errorf("loading session: %w", err)
	}
	if ownerID.Valid {
		r.owner = &Owner{DeviceID: ownerID.String, Name: name.String, Generation: r.generation, LastSeenAt: Timestamp{fromMS(lastSeen.Int64)}}
	}
	return r, nil
}

// requireOwner returns a stale_owner conflict unless deviceID owns the
// session at generation gen.
func (r sessionRow) requireOwner(deviceID string, gen int64) error {
	if r.owner == nil || r.owner.DeviceID != deviceID || r.generation != gen {
		return &ConflictError{Code: CodeStaleOwner, Owner: r.owner}
	}
	return nil
}

// requireActiveDevice returns the session of deviceID and fails with
// ErrRevoked unless the device exists and is not revoked. Every store method
// calls it inside its transaction and scopes all queries to the returned
// session: authentication happens in an earlier, separate statement, and the
// session may have been deleted since.
func requireActiveDevice(ctx context.Context, tx *sql.Tx, deviceID string) (int64, error) {
	var (
		sid     int64
		revoked sql.NullInt64
	)
	err := tx.QueryRowContext(ctx, `SELECT session_id, revoked_at FROM devices WHERE id = ?`, deviceID).Scan(&sid, &revoked)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && revoked.Valid) {
		return 0, ErrRevoked
	}
	if err != nil {
		return 0, fmt.Errorf("checking device: %w", err)
	}
	return sid, nil
}

func touchOwner(ctx context.Context, tx *sql.Tx, sid int64, now time.Time) error {
	if _, err := tx.ExecContext(ctx, `UPDATE sessions SET owner_last_seen_at = ? WHERE id = ?`, ms(now), sid); err != nil {
		return fmt.Errorf("refreshing owner: %w", err)
	}
	return nil
}

const entryColumns = `id, url_key, url_enc, pinned, position, opened_by, created_revision, updated_revision, closed_revision,
	url_revision, url_device`

func queryEntries(ctx context.Context, tx *sql.Tx, query string, args ...any) ([]session.Entry, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("loading entries: %w", err)
	}
	defer rows.Close()
	var out []session.Entry
	for rows.Next() {
		var (
			e      session.Entry
			closed sql.NullInt64
		)
		if err := rows.Scan(&e.ID, &e.URLKey, &e.URLEnc, &e.Pinned, &e.Position, &e.OpenedBy, &e.CreatedRevision, &e.UpdatedRevision, &closed,
			&e.URLRevision, &e.URLDevice); err != nil {
			return nil, fmt.Errorf("scanning entry: %w", err)
		}
		if closed.Valid {
			c := closed.Int64
			e.ClosedRevision = &c
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("loading entries: %w", err)
	}
	return out, nil
}

func openEntries(ctx context.Context, tx *sql.Tx, sid int64) ([]session.Entry, error) {
	return queryEntries(ctx, tx, `SELECT `+entryColumns+` FROM entries WHERE session_id = ? AND closed_revision IS NULL
		ORDER BY position, id`, sid)
}

// GetSession returns the session of deviceID with its open entries.
func (s *Store) GetSession(ctx context.Context, deviceID string) (Session, error) {
	var out Session
	err := s.tx(ctx, func(tx *sql.Tx) error {
		sid, err := requireActiveDevice(ctx, tx, deviceID)
		if err != nil {
			return err
		}
		r, err := loadSession(ctx, tx, sid)
		if err != nil {
			return err
		}
		es, err := openEntries(ctx, tx, sid)
		if err != nil {
			return err
		}
		out = Session{Revision: r.revision, MinRevision: r.minRevision, KeyCheck: r.keyCheck, Owner: r.owner, Entries: es}
		return nil
	})
	return out, err
}

// Acquire makes deviceID the owner following the acquire rules: an existing
// owner keeps its generation; a missing or stale (lastSeenAt older than
// liveness) owner, or force, moves ownership and increments the generation;
// otherwise it fails with an owner_active conflict.
func (s *Store) Acquire(ctx context.Context, deviceID string, force bool, now time.Time, liveness time.Duration) (int64, Session, error) {
	var (
		gen int64
		out Session
	)
	err := s.tx(ctx, func(tx *sql.Tx) error {
		sid, err := requireActiveDevice(ctx, tx, deviceID)
		if err != nil {
			return err
		}
		r, err := loadSession(ctx, tx, sid)
		if err != nil {
			return err
		}
		switch {
		case r.owner != nil && r.owner.DeviceID == deviceID:
			if err := touchOwner(ctx, tx, sid, now); err != nil {
				return err
			}
		case r.owner != nil && !force && now.Sub(r.owner.LastSeenAt.Time) <= liveness:
			return &ConflictError{Code: CodeOwnerActive, Owner: r.owner}
		default:
			if _, err := tx.ExecContext(ctx,
				`UPDATE sessions SET generation = generation + 1, owner_device_id = ?, owner_last_seen_at = ? WHERE id = ?`,
				deviceID, ms(now), sid); err != nil {
				return fmt.Errorf("acquiring ownership: %w", err)
			}
		}
		if r, err = loadSession(ctx, tx, sid); err != nil {
			return err
		}
		es, err := openEntries(ctx, tx, sid)
		if err != nil {
			return err
		}
		gen = r.generation
		out = Session{Revision: r.revision, MinRevision: r.minRevision, KeyCheck: r.keyCheck, Owner: r.owner, Entries: es}
		return nil
	})
	return gen, out, err
}

// Release gives up ownership.
func (s *Store) Release(ctx context.Context, deviceID string, gen int64) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		sid, err := requireActiveDevice(ctx, tx, deviceID)
		if err != nil {
			return err
		}
		r, err := loadSession(ctx, tx, sid)
		if err != nil {
			return err
		}
		if err := r.requireOwner(deviceID, gen); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE sessions SET owner_device_id = NULL, owner_last_seen_at = NULL WHERE id = ?`, sid); err != nil {
			return fmt.Errorf("releasing ownership: %w", err)
		}
		return nil
	})
}

// Heartbeat refreshes the owner's lastSeenAt.
func (s *Store) Heartbeat(ctx context.Context, deviceID string, gen int64, now time.Time) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		sid, err := requireActiveDevice(ctx, tx, deviceID)
		if err != nil {
			return err
		}
		r, err := loadSession(ctx, tx, sid)
		if err != nil {
			return err
		}
		if err := r.requireOwner(deviceID, gen); err != nil {
			return err
		}
		return touchOwner(ctx, tx, sid, now)
	})
}

// Changes returns the operations applied in the session of deviceID after
// revision since. It fails with ErrHistoryExpired when since is outside the
// retained history.
func (s *Store) Changes(ctx context.Context, deviceID string, since int64) (ChangeSet, error) {
	var out ChangeSet
	err := s.tx(ctx, func(tx *sql.Tx) error {
		sid, err := requireActiveDevice(ctx, tx, deviceID)
		if err != nil {
			return err
		}
		r, err := loadSession(ctx, tx, sid)
		if err != nil {
			return err
		}
		if since < 0 || since > r.revision || r.expired(since) {
			return ErrHistoryExpired
		}
		out = ChangeSet{Revision: r.revision, MinRevision: r.minRevision, Owner: r.owner}
		out.Operations, err = loggedOps(ctx, tx, `SELECT seq, device_id, payload, result FROM operations WHERE session_id = ? AND seq > ? ORDER BY seq`, sid, since)
		return err
	})
	return out, err
}

func loggedOps(ctx context.Context, tx *sql.Tx, query string, args ...any) ([]LoggedOp, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("loading operations: %w", err)
	}
	defer rows.Close()
	out := []LoggedOp{}
	for rows.Next() {
		var (
			o               LoggedOp
			payload, result string
		)
		if err := rows.Scan(&o.Seq, &o.DeviceID, &payload, &result); err != nil {
			return nil, fmt.Errorf("scanning operation: %w", err)
		}
		o.Op, o.Result = json.RawMessage(payload), json.RawMessage(result)
		out = append(out, o)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("loading operations: %w", err)
	}
	return out, nil
}

// ApplyOperations applies a validated batch atomically for the owner at
// generation gen. catchUp holds other devices' operations after baseRevision,
// unless baseRevision is outside the retained history (FullResync).
func (s *Store) ApplyOperations(ctx context.Context, deviceID string, gen, baseRevision int64, ops []session.Op, now time.Time, retention int) (BatchResult, error) {
	var out BatchResult
	err := s.tx(ctx, func(tx *sql.Tx) error {
		sid, err := requireActiveDevice(ctx, tx, deviceID)
		if err != nil {
			return err
		}
		r, err := loadSession(ctx, tx, sid)
		if err != nil {
			return err
		}
		if err := r.requireOwner(deviceID, gen); err != nil {
			return err
		}
		if err := touchOwner(ctx, tx, sid, now); err != nil {
			return err
		}
		if out.FullResync = r.expired(baseRevision); !out.FullResync {
			out.CatchUp, err = loggedOps(ctx, tx,
				`SELECT seq, device_id, payload, result FROM operations WHERE session_id = ? AND seq > ? AND device_id != ? ORDER BY seq`,
				sid, baseRevision, deviceID)
			if err != nil {
				return err
			}
		}
		out.Results, out.Revision, err = applyBatch(ctx, tx, batch{
			session: sid, deviceID: deviceID, generation: gen, revision: r.revision, ops: ops,
			now: now, retention: retention, reason: ReasonOperations,
		})
		return err
	})
	return out, err
}

// Merge applies a validated offline journal atomically for any active
// device, owner or not, with per-operation causal checks against each
// operation's baseRevision (see session.State.Merge). Ownership is neither
// required nor changed. Merged operations are logged with generation 0.
func (s *Store) Merge(ctx context.Context, deviceID string, ops []session.MergeOp, now time.Time, retention int) (BatchResult, error) {
	var out BatchResult
	err := s.tx(ctx, func(tx *sql.Tx) error {
		sid, err := requireActiveDevice(ctx, tx, deviceID)
		if err != nil {
			return err
		}
		r, err := loadSession(ctx, tx, sid)
		if err != nil {
			return err
		}
		plain := make([]session.Op, len(ops))
		expired := make([]bool, len(ops))
		bases := make([]int64, len(ops))
		for i, op := range ops {
			plain[i], bases[i] = op.Op, *op.BaseRevision
			// A base ahead of the session (e.g. after a server restore) is
			// as untrustworthy as one outside the retained history.
			expired[i] = r.expired(bases[i]) || bases[i] > r.revision
		}
		out.Results, out.Revision, err = applyBatch(ctx, tx, batch{
			session: sid, deviceID: deviceID, revision: r.revision, ops: plain, now: now, retention: retention,
			reason: ReasonOperations, merge: &mergeInfo{bases: bases, expired: expired},
		})
		return err
	})
	return out, err
}

type mergeInfo struct {
	bases   []int64 // per-op baseRevision
	expired []bool  // per-op: base outside the retained history or ahead of the session
}

type batch struct {
	session    int64
	deviceID   string
	generation int64
	revision   int64
	ops        []session.Op
	merge      *mergeInfo // non-nil: apply with merge rules
	now        time.Time
	retention  int
	reason     string // snapshot reason
	snapshot   bool   // snapshot when any op is new, regardless of op types
}

// applyBatch applies ops in order, saving a recovery snapshot first when the
// batch contains new close or navigate operations (or, with b.snapshot, any
// new operation). Pure replays never snapshot.
func applyBatch(ctx context.Context, tx *sql.Tx, b batch) ([]session.Result, int64, error) {
	stored := make(map[string]session.Result, len(b.ops))
	ids := make([]string, 0, len(b.ops))
	needSnapshot := false
	for _, op := range b.ops {
		var raw string
		err := tx.QueryRowContext(ctx, `SELECT result FROM operations WHERE session_id = ? AND op_id = ?`, b.session, op.OpID).Scan(&raw)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			if b.snapshot || op.Type == session.TypeClose || op.Type == session.TypeNavigate {
				needSnapshot = true
			}
		case err != nil:
			return nil, 0, fmt.Errorf("looking up operation: %w", err)
		default:
			var res session.Result
			if err := json.Unmarshal([]byte(raw), &res); err != nil {
				return nil, 0, fmt.Errorf("decoding stored result: %w", err)
			}
			stored[op.OpID] = replayResult(op, res)
		}
		ids = append(ids, op.EntryID)
		if b.merge != nil && op.Type == session.TypeNavigate {
			ids = append(ids, session.ForkedEntryID(op.OpID)) // a fork may already exist as a tombstone
		}
	}

	idsJSON, err := json.Marshal(ids)
	if err != nil {
		return nil, 0, fmt.Errorf("encoding entry ids: %w", err)
	}
	entries, err := queryEntries(ctx, tx, `SELECT `+entryColumns+` FROM entries
		WHERE session_id = ? AND (closed_revision IS NULL OR id IN (SELECT value FROM json_each(?)))`, b.session, string(idsJSON))
	if err != nil {
		return nil, 0, err
	}
	st := session.NewState(entries)

	if needSnapshot {
		if err := saveSnapshot(ctx, tx, b, st.OpenEntries()); err != nil {
			return nil, 0, err
		}
	}

	rev := b.revision
	results := make([]session.Result, 0, len(b.ops))
	for i, op := range b.ops {
		if res, ok := stored[op.OpID]; ok {
			res.Replayed = true
			results = append(results, res)
			continue
		}
		var (
			res     session.Result
			changed *session.Entry
		)
		if b.merge != nil {
			res, changed, op = st.Merge(op, b.merge.bases[i], b.merge.expired[i], b.deviceID, rev+1)
		} else {
			res, changed = st.Apply(op, b.deviceID, rev+1)
		}
		var seq any
		if res.Status != session.StatusIgnored {
			rev++
			seq = rev
		}
		if changed != nil {
			if err := upsertEntry(ctx, tx, b.session, changed); err != nil {
				return nil, 0, err
			}
		}
		payload, err := json.Marshal(op)
		if err != nil {
			return nil, 0, fmt.Errorf("encoding operation: %w", err)
		}
		result, err := json.Marshal(logResult(res))
		if err != nil {
			return nil, 0, fmt.Errorf("encoding result: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO operations
			(session_id, op_id, seq, device_id, generation, type, payload, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			b.session, op.OpID, seq, b.deviceID, b.generation, op.Type, string(payload), string(result), ms(b.now)); err != nil {
			return nil, 0, fmt.Errorf("logging operation: %w", err)
		}
		stored[op.OpID] = res
		results = append(results, res)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE sessions SET revision = ? WHERE id = ?`, rev, b.session); err != nil {
		return nil, 0, fmt.Errorf("updating revision: %w", err)
	}
	return results, rev, nil
}

// logResult is the result as stored in the log, which changes and catchUp
// expose: a fork is the applied open it was converted to. replayResult
// restores the merge response's "forked" from the submitted navigate, whose
// result entry is then its own fork id (nothing else can produce that id).
func logResult(res session.Result) session.Result {
	if res.Status == session.StatusForked {
		res.Status = session.StatusApplied
	}
	return res
}

func replayResult(submitted session.Op, res session.Result) session.Result {
	if submitted.Type == session.TypeNavigate && res.Status == session.StatusApplied &&
		res.EntryID == session.ForkedEntryID(submitted.OpID) {
		res.Status = session.StatusForked
	}
	return res
}

func upsertEntry(ctx context.Context, tx *sql.Tx, sid int64, e *session.Entry) error {
	var closed any
	if e.ClosedRevision != nil {
		closed = *e.ClosedRevision
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO entries (session_id, `+entryColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (session_id, id) DO UPDATE SET url_key = excluded.url_key, url_enc = excluded.url_enc, pinned = excluded.pinned, position = excluded.position,
			updated_revision = excluded.updated_revision, closed_revision = excluded.closed_revision,
			url_revision = excluded.url_revision, url_device = excluded.url_device`,
		sid, e.ID, e.URLKey, e.URLEnc, e.Pinned, e.Position, e.OpenedBy, e.CreatedRevision, e.UpdatedRevision, closed, e.URLRevision, e.URLDevice)
	if err != nil {
		return fmt.Errorf("writing entry: %w", err)
	}
	return nil
}

// saveSnapshot stores the open entries under the session's next snapshot id
// and prunes beyond retention. Empty sessions are not snapshotted.
func saveSnapshot(ctx context.Context, tx *sql.Tx, b batch, open []session.Entry) error {
	if len(open) == 0 {
		return nil
	}
	items := make([]snapshotEntry, len(open))
	for i, e := range open {
		items[i] = snapshotEntry{ID: e.ID, URLKey: e.URLKey, URLEnc: e.URLEnc, Pinned: e.Pinned, Position: e.Position}
	}
	data, err := json.Marshal(items)
	if err != nil {
		return fmt.Errorf("encoding snapshot: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO snapshots (session_id, id, revision, device_id, reason, created_at, entry_count, entries)
		VALUES (?1, (SELECT COALESCE(MAX(id), 0) + 1 FROM snapshots WHERE session_id = ?1), ?, ?, ?, ?, ?, ?)`,
		b.session, b.revision, b.deviceID, b.reason, ms(b.now), len(items), string(data)); err != nil {
		return fmt.Errorf("saving snapshot: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM snapshots WHERE session_id = ?1 AND id NOT IN
		(SELECT id FROM snapshots WHERE session_id = ?1 ORDER BY id DESC LIMIT ?2)`, b.session, b.retention); err != nil {
		return fmt.Errorf("pruning snapshots: %w", err)
	}
	return nil
}

// ListSnapshots returns the snapshots of the session of deviceID, newest first.
func (s *Store) ListSnapshots(ctx context.Context, deviceID string) ([]Snapshot, error) {
	out := []Snapshot{}
	err := s.tx(ctx, func(tx *sql.Tx) error {
		sid, err := requireActiveDevice(ctx, tx, deviceID)
		if err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, `SELECT id, revision, device_id, reason, created_at, entry_count FROM snapshots
			WHERE session_id = ? ORDER BY id DESC`, sid)
		if err != nil {
			return fmt.Errorf("listing snapshots: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var (
				sn      Snapshot
				created int64
			)
			if err := rows.Scan(&sn.ID, &sn.Revision, &sn.DeviceID, &sn.Reason, &created, &sn.EntryCount); err != nil {
				return fmt.Errorf("scanning snapshot: %w", err)
			}
			sn.CreatedAt = Timestamp{fromMS(created)}
			out = append(out, sn)
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("listing snapshots: %w", err)
		}
		return nil
	})
	return out, err
}

// restoreNamespace seeds the deterministic (UUIDv5) ids of restore operations.
var restoreNamespace = uuid.MustParse("5b0c6f0e-3d1a-4f7e-9c2b-8a4d6e1f2c30")

// restoreID derives a stable id so that retrying the same restore in the same
// generation replays the stored results instead of applying again.
func restoreID(kind string, snapshotID, gen int64, index int) string {
	return uuid.NewSHA1(restoreNamespace, fmt.Appendf(nil, "%s:%d:%d:%d", kind, snapshotID, gen, index)).String()
}

// RestoreSnapshot re-opens a snapshot's URLs (urlKey and urlEnc) as ordinary
// open operations under the caller's generation, after saving a pre-restore
// snapshot. Open URLs coalesce on urlKey; nothing is closed or rewound. Op
// and entry ids derive from (snapshot, generation, index), so a retry in the
// same generation is a replay.
func (s *Store) RestoreSnapshot(ctx context.Context, deviceID string, gen, id int64, now time.Time, retention int) (BatchResult, error) {
	var out BatchResult
	err := s.tx(ctx, func(tx *sql.Tx) error {
		sid, err := requireActiveDevice(ctx, tx, deviceID)
		if err != nil {
			return err
		}
		r, err := loadSession(ctx, tx, sid)
		if err != nil {
			return err
		}
		if err := r.requireOwner(deviceID, gen); err != nil {
			return err
		}
		var raw string
		err = tx.QueryRowContext(ctx, `SELECT entries FROM snapshots WHERE session_id = ? AND id = ?`, sid, id).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("loading snapshot: %w", err)
		}
		var items []snapshotEntry
		if err := json.Unmarshal([]byte(raw), &items); err != nil {
			return fmt.Errorf("decoding snapshot: %w", err)
		}
		ops := make([]session.Op, len(items))
		for i, it := range items {
			ops[i] = session.Op{
				OpID: restoreID("op", id, gen, i), Type: session.TypeOpen, EntryID: restoreID("entry", id, gen, i),
				URLKey: it.URLKey, URLEnc: it.URLEnc, Pinned: &it.Pinned, Position: &it.Position,
			}
		}
		if err := touchOwner(ctx, tx, sid, now); err != nil {
			return err
		}
		out.Results, out.Revision, err = applyBatch(ctx, tx, batch{
			session: sid, deviceID: deviceID, generation: gen, revision: r.revision, ops: ops,
			now: now, retention: retention, reason: ReasonRestore, snapshot: true,
		})
		return err
	})
	return out, err
}
