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

// Session is the current shared session with its open entries.
type Session struct {
	Revision int64
	Owner    *Owner
	Entries  []session.Entry
}

// LoggedOp is one applied operation from the log.
type LoggedOp struct {
	Seq      int64           `json:"seq"`
	DeviceID string          `json:"deviceId"`
	Op       json.RawMessage `json:"op"`
	Result   json.RawMessage `json:"result"`
}

// BatchResult is the outcome of an operations batch or a restore.
type BatchResult struct {
	Revision int64
	Results  []session.Result
	CatchUp  []LoggedOp
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
	URL      string `json:"url"`
	Pinned   bool   `json:"pinned"`
	Position int64  `json:"position"`
}

type sessionRow struct {
	revision   int64
	generation int64
	owner      *Owner
}

func loadSession(ctx context.Context, tx *sql.Tx) (sessionRow, error) {
	var (
		r        sessionRow
		ownerID  sql.NullString
		lastSeen sql.NullInt64
		name     sql.NullString
	)
	err := tx.QueryRowContext(ctx, `SELECT s.revision, s.generation, s.owner_device_id, s.owner_last_seen_at, d.name
		FROM session s LEFT JOIN devices d ON d.id = s.owner_device_id WHERE s.id = 1`).
		Scan(&r.revision, &r.generation, &ownerID, &lastSeen, &name)
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

// requireActiveDevice fails with ErrRevoked unless the device exists and is
// not revoked. Write paths call it inside their transaction because
// authentication happens in an earlier, separate statement.
func requireActiveDevice(ctx context.Context, tx *sql.Tx, deviceID string) error {
	var revoked sql.NullInt64
	err := tx.QueryRowContext(ctx, `SELECT revoked_at FROM devices WHERE id = ?`, deviceID).Scan(&revoked)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && revoked.Valid) {
		return ErrRevoked
	}
	if err != nil {
		return fmt.Errorf("checking device: %w", err)
	}
	return nil
}

func touchOwner(ctx context.Context, tx *sql.Tx, now time.Time) error {
	if _, err := tx.ExecContext(ctx, `UPDATE session SET owner_last_seen_at = ? WHERE id = 1`, ms(now)); err != nil {
		return fmt.Errorf("refreshing owner: %w", err)
	}
	return nil
}

const entryColumns = `id, url, pinned, position, opened_by, created_revision, updated_revision, closed_revision`

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
		if err := rows.Scan(&e.ID, &e.URL, &e.Pinned, &e.Position, &e.OpenedBy, &e.CreatedRevision, &e.UpdatedRevision, &closed); err != nil {
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

func openEntries(ctx context.Context, tx *sql.Tx) ([]session.Entry, error) {
	return queryEntries(ctx, tx, `SELECT `+entryColumns+` FROM entries WHERE closed_revision IS NULL ORDER BY position, id`)
}

// GetSession returns the session with its open entries.
func (s *Store) GetSession(ctx context.Context) (Session, error) {
	var out Session
	err := s.tx(ctx, func(tx *sql.Tx) error {
		r, err := loadSession(ctx, tx)
		if err != nil {
			return err
		}
		es, err := openEntries(ctx, tx)
		if err != nil {
			return err
		}
		out = Session{Revision: r.revision, Owner: r.owner, Entries: es}
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
		if err := requireActiveDevice(ctx, tx, deviceID); err != nil {
			return err
		}
		r, err := loadSession(ctx, tx)
		if err != nil {
			return err
		}
		switch {
		case r.owner != nil && r.owner.DeviceID == deviceID:
			if err := touchOwner(ctx, tx, now); err != nil {
				return err
			}
		case r.owner != nil && !force && now.Sub(r.owner.LastSeenAt.Time) <= liveness:
			return &ConflictError{Code: CodeOwnerActive, Owner: r.owner}
		default:
			if _, err := tx.ExecContext(ctx,
				`UPDATE session SET generation = generation + 1, owner_device_id = ?, owner_last_seen_at = ? WHERE id = 1`,
				deviceID, ms(now)); err != nil {
				return fmt.Errorf("acquiring ownership: %w", err)
			}
		}
		if r, err = loadSession(ctx, tx); err != nil {
			return err
		}
		es, err := openEntries(ctx, tx)
		if err != nil {
			return err
		}
		gen = r.generation
		out = Session{Revision: r.revision, Owner: r.owner, Entries: es}
		return nil
	})
	return gen, out, err
}

// Release gives up ownership.
func (s *Store) Release(ctx context.Context, deviceID string, gen int64) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := requireActiveDevice(ctx, tx, deviceID); err != nil {
			return err
		}
		r, err := loadSession(ctx, tx)
		if err != nil {
			return err
		}
		if err := r.requireOwner(deviceID, gen); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE session SET owner_device_id = NULL, owner_last_seen_at = NULL WHERE id = 1`); err != nil {
			return fmt.Errorf("releasing ownership: %w", err)
		}
		return nil
	})
}

// Heartbeat refreshes the owner's lastSeenAt.
func (s *Store) Heartbeat(ctx context.Context, deviceID string, gen int64, now time.Time) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := requireActiveDevice(ctx, tx, deviceID); err != nil {
			return err
		}
		r, err := loadSession(ctx, tx)
		if err != nil {
			return err
		}
		if err := r.requireOwner(deviceID, gen); err != nil {
			return err
		}
		return touchOwner(ctx, tx, now)
	})
}

// Changes returns the operations applied after revision since.
func (s *Store) Changes(ctx context.Context, since int64) (int64, *Owner, []LoggedOp, error) {
	var (
		rev   int64
		owner *Owner
		ops   []LoggedOp
	)
	err := s.tx(ctx, func(tx *sql.Tx) error {
		r, err := loadSession(ctx, tx)
		if err != nil {
			return err
		}
		if since < 0 || since > r.revision {
			return ErrHistoryExpired
		}
		rev, owner = r.revision, r.owner
		ops, err = loggedOps(ctx, tx, `SELECT seq, device_id, payload, result FROM operations WHERE seq > ? ORDER BY seq`, since)
		return err
	})
	return rev, owner, ops, err
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
// generation gen. catchUp holds other devices' operations after baseRevision.
func (s *Store) ApplyOperations(ctx context.Context, deviceID string, gen, baseRevision int64, ops []session.Op, now time.Time, retention int) (BatchResult, error) {
	var out BatchResult
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if err := requireActiveDevice(ctx, tx, deviceID); err != nil {
			return err
		}
		r, err := loadSession(ctx, tx)
		if err != nil {
			return err
		}
		if err := r.requireOwner(deviceID, gen); err != nil {
			return err
		}
		if err := touchOwner(ctx, tx, now); err != nil {
			return err
		}
		out.CatchUp, err = loggedOps(ctx, tx,
			`SELECT seq, device_id, payload, result FROM operations WHERE seq > ? AND device_id != ? ORDER BY seq`,
			baseRevision, deviceID)
		if err != nil {
			return err
		}
		out.Results, out.Revision, err = applyBatch(ctx, tx, batch{
			deviceID: deviceID, generation: gen, revision: r.revision, ops: ops,
			now: now, retention: retention, reason: ReasonOperations,
		})
		return err
	})
	return out, err
}

type batch struct {
	deviceID   string
	generation int64
	revision   int64
	ops        []session.Op
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
		err := tx.QueryRowContext(ctx, `SELECT result FROM operations WHERE op_id = ?`, op.OpID).Scan(&raw)
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
			stored[op.OpID] = res
		}
		ids = append(ids, op.EntryID)
	}

	idsJSON, err := json.Marshal(ids)
	if err != nil {
		return nil, 0, fmt.Errorf("encoding entry ids: %w", err)
	}
	entries, err := queryEntries(ctx, tx, `SELECT `+entryColumns+` FROM entries
		WHERE closed_revision IS NULL OR id IN (SELECT value FROM json_each(?))`, string(idsJSON))
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
	for _, op := range b.ops {
		if res, ok := stored[op.OpID]; ok {
			res.Replayed = true
			results = append(results, res)
			continue
		}
		res, changed := st.Apply(op, b.deviceID, rev+1)
		var seq any
		if res.Status != session.StatusIgnored {
			rev++
			seq = rev
		}
		if changed != nil {
			if err := upsertEntry(ctx, tx, changed); err != nil {
				return nil, 0, err
			}
		}
		payload, err := json.Marshal(op)
		if err != nil {
			return nil, 0, fmt.Errorf("encoding operation: %w", err)
		}
		result, err := json.Marshal(res)
		if err != nil {
			return nil, 0, fmt.Errorf("encoding result: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO operations
			(op_id, seq, device_id, generation, type, payload, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			op.OpID, seq, b.deviceID, b.generation, op.Type, string(payload), string(result), ms(b.now)); err != nil {
			return nil, 0, fmt.Errorf("logging operation: %w", err)
		}
		stored[op.OpID] = res
		results = append(results, res)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE session SET revision = ? WHERE id = 1`, rev); err != nil {
		return nil, 0, fmt.Errorf("updating revision: %w", err)
	}
	return results, rev, nil
}

func upsertEntry(ctx context.Context, tx *sql.Tx, e *session.Entry) error {
	var closed any
	if e.ClosedRevision != nil {
		closed = *e.ClosedRevision
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO entries (`+entryColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET url = excluded.url, pinned = excluded.pinned, position = excluded.position,
			updated_revision = excluded.updated_revision, closed_revision = excluded.closed_revision`,
		e.ID, e.URL, e.Pinned, e.Position, e.OpenedBy, e.CreatedRevision, e.UpdatedRevision, closed)
	if err != nil {
		return fmt.Errorf("writing entry: %w", err)
	}
	return nil
}

// saveSnapshot stores the open entries and prunes beyond retention. Empty
// sessions are not snapshotted.
func saveSnapshot(ctx context.Context, tx *sql.Tx, b batch, open []session.Entry) error {
	if len(open) == 0 {
		return nil
	}
	items := make([]snapshotEntry, len(open))
	for i, e := range open {
		items[i] = snapshotEntry{ID: e.ID, URL: e.URL, Pinned: e.Pinned, Position: e.Position}
	}
	data, err := json.Marshal(items)
	if err != nil {
		return fmt.Errorf("encoding snapshot: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO snapshots (revision, device_id, reason, created_at, entry_count, entries)
		VALUES (?, ?, ?, ?, ?, ?)`, b.revision, b.deviceID, b.reason, ms(b.now), len(items), string(data)); err != nil {
		return fmt.Errorf("saving snapshot: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM snapshots WHERE id NOT IN
		(SELECT id FROM snapshots ORDER BY id DESC LIMIT ?)`, b.retention); err != nil {
		return fmt.Errorf("pruning snapshots: %w", err)
	}
	return nil
}

// ListSnapshots returns stored snapshots, newest first.
func (s *Store) ListSnapshots(ctx context.Context) ([]Snapshot, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, revision, device_id, reason, created_at, entry_count FROM snapshots ORDER BY id DESC`)
	if err != nil {
		return nil, fmt.Errorf("listing snapshots: %w", err)
	}
	defer rows.Close()
	out := []Snapshot{}
	for rows.Next() {
		var (
			sn      Snapshot
			created int64
		)
		if err := rows.Scan(&sn.ID, &sn.Revision, &sn.DeviceID, &sn.Reason, &created, &sn.EntryCount); err != nil {
			return nil, fmt.Errorf("scanning snapshot: %w", err)
		}
		sn.CreatedAt = Timestamp{fromMS(created)}
		out = append(out, sn)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("listing snapshots: %w", err)
	}
	return out, nil
}

// restoreNamespace seeds the deterministic (UUIDv5) ids of restore operations.
var restoreNamespace = uuid.MustParse("5b0c6f0e-3d1a-4f7e-9c2b-8a4d6e1f2c30")

// restoreID derives a stable id so that retrying the same restore in the same
// generation replays the stored results instead of applying again.
func restoreID(kind string, snapshotID, gen int64, index int) string {
	return uuid.NewSHA1(restoreNamespace, fmt.Appendf(nil, "%s:%d:%d:%d", kind, snapshotID, gen, index)).String()
}

// RestoreSnapshot re-opens a snapshot's URLs as ordinary open operations
// under the caller's generation, after saving a pre-restore snapshot. Open
// URLs coalesce; nothing is closed or rewound. Op and entry ids derive from
// (snapshot, generation, index), so a retry in the same generation is a replay.
func (s *Store) RestoreSnapshot(ctx context.Context, deviceID string, gen, id int64, now time.Time, retention int) (BatchResult, error) {
	var out BatchResult
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if err := requireActiveDevice(ctx, tx, deviceID); err != nil {
			return err
		}
		r, err := loadSession(ctx, tx)
		if err != nil {
			return err
		}
		if err := r.requireOwner(deviceID, gen); err != nil {
			return err
		}
		var raw string
		err = tx.QueryRowContext(ctx, `SELECT entries FROM snapshots WHERE id = ?`, id).Scan(&raw)
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
				URL: it.URL, Pinned: &it.Pinned, Position: &it.Position,
			}
		}
		if err := touchOwner(ctx, tx, now); err != nil {
			return err
		}
		out.Results, out.Revision, err = applyBatch(ctx, tx, batch{
			deviceID: deviceID, generation: gen, revision: r.revision, ops: ops,
			now: now, retention: retention, reason: ReasonRestore, snapshot: true,
		})
		return err
	})
	return out, err
}
