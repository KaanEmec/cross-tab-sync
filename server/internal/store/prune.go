package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// PruneResult reports what one pruning pass removed.
type PruneResult struct {
	Sessions   int64 // inactive sessions deleted with all their rows
	Operations int64 // log rows deleted (applied and ignored)
	Tombstones int64 // closed entries deleted
}

// Prune deletes sessions none of whose devices has been seen since
// now-sessionRetention, together with all their rows, and then, per
// remaining session, history older than historyRetention (pruneHistory).
func (s *Store) Prune(ctx context.Context, now time.Time, historyRetention, sessionRetention time.Duration) (PruneResult, error) {
	var out PruneResult
	err := s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE NOT EXISTS
			(SELECT 1 FROM devices WHERE session_id = sessions.id AND last_seen_at >= ?)`, ms(now.Add(-sessionRetention)))
		if err != nil {
			return fmt.Errorf("pruning sessions: %w", err)
		}
		if out.Sessions, err = res.RowsAffected(); err != nil {
			return fmt.Errorf("pruning sessions: %w", err)
		}
		return nil
	})
	if err != nil {
		return out, err
	}
	ids, err := s.sessionIDs(ctx)
	if err != nil {
		return out, err
	}
	cutoff := ms(now.Add(-historyRetention))
	for _, sid := range ids {
		// One transaction per session keeps the write lock short.
		err := s.tx(ctx, func(tx *sql.Tx) error {
			ops, tombs, err := pruneHistory(ctx, tx, sid, cutoff)
			out.Operations += ops
			out.Tombstones += tombs
			return err
		})
		if err != nil {
			return out, err
		}
	}
	return out, nil
}

func (s *Store) sessionIDs(ctx context.Context) ([]int64, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM sessions ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("listing sessions: %w", err)
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("listing sessions: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("listing sessions: %w", err)
	}
	return ids, nil
}

// pruneHistory deletes the history of session sid created before cutoff:
// operations and the tombstones whose closing operation was deleted. Open
// entries are always kept. Applied operations are cut at a single sequence
// number so the retained log stays contiguous from minRevision to revision;
// minRevision never moves backwards. Pruned opIds are treated as new
// operations if they are ever submitted again. A session deleted meanwhile
// is skipped.
func pruneHistory(ctx context.Context, tx *sql.Tx, sid, cutoff int64) (ops, tombstones int64, err error) {
	r, err := loadSession(ctx, tx, sid)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, 0, nil
	}
	if err != nil {
		return 0, 0, err
	}
	// The first applied operation inside the retention window; without one,
	// everything up to the current revision is prunable.
	var first sql.NullInt64
	if err := tx.QueryRowContext(ctx,
		`SELECT MIN(seq) FROM operations WHERE session_id = ? AND seq IS NOT NULL AND created_at >= ?`, sid, cutoff).Scan(&first); err != nil {
		return 0, 0, fmt.Errorf("finding retained history: %w", err)
	}
	minRev := r.revision + 1
	if first.Valid {
		minRev = first.Int64
	}
	minRev = max(minRev, r.minRevision)

	res, err := tx.ExecContext(ctx,
		`DELETE FROM operations WHERE session_id = ? AND (seq < ? OR (seq IS NULL AND created_at < ?))`, sid, minRev, cutoff)
	if err != nil {
		return 0, 0, fmt.Errorf("pruning operations: %w", err)
	}
	if ops, err = res.RowsAffected(); err != nil {
		return 0, 0, fmt.Errorf("pruning operations: %w", err)
	}
	res, err = tx.ExecContext(ctx,
		`DELETE FROM entries WHERE session_id = ? AND closed_revision IS NOT NULL AND closed_revision < ?`, sid, minRev)
	if err != nil {
		return 0, 0, fmt.Errorf("pruning tombstones: %w", err)
	}
	if tombstones, err = res.RowsAffected(); err != nil {
		return 0, 0, fmt.Errorf("pruning tombstones: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE sessions SET min_revision = ? WHERE id = ?`, minRev, sid); err != nil {
		return 0, 0, fmt.Errorf("updating min revision: %w", err)
	}
	return ops, tombstones, nil
}

// RunPruner prunes once immediately and then on every tick until ctx is
// done. now supplies the clock. Failures are logged and retried on the next
// tick.
func (s *Store) RunPruner(ctx context.Context, ticks <-chan time.Time, historyRetention, sessionRetention time.Duration,
	now func() time.Time, log *slog.Logger) {
	for {
		res, err := s.Prune(ctx, now(), historyRetention, sessionRetention)
		switch {
		case err != nil && ctx.Err() == nil:
			log.LogAttrs(ctx, slog.LevelError, "pruning failed", slog.String("error", err.Error()))
		case err == nil && res.Sessions+res.Operations+res.Tombstones > 0:
			log.LogAttrs(ctx, slog.LevelInfo, "pruned",
				slog.Int64("sessions", res.Sessions), slog.Int64("operations", res.Operations),
				slog.Int64("tombstones", res.Tombstones))
		}
		select {
		case <-ctx.Done():
			return
		case <-ticks:
		}
	}
}
