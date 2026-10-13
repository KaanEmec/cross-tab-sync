package store

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"time"
)

// PruneResult reports what one pruning pass removed.
type PruneResult struct {
	Operations  int64 // log rows deleted (applied and ignored)
	Tombstones  int64 // closed entries deleted
	MinRevision int64 // oldest retained sequence number afterwards
}

// Prune deletes history older than retention: operations created before
// now-retention and the tombstones whose closing operation was deleted. Open
// entries are always kept. Applied operations are cut at a single sequence
// number so the retained log stays contiguous from minRevision to revision;
// minRevision never moves backwards. Pruned opIds are treated as new
// operations if they are ever submitted again.
func (s *Store) Prune(ctx context.Context, now time.Time, retention time.Duration) (PruneResult, error) {
	var out PruneResult
	cutoff := ms(now.Add(-retention))
	err := s.tx(ctx, func(tx *sql.Tx) error {
		r, err := loadSession(ctx, tx)
		if err != nil {
			return err
		}
		// The first applied operation inside the retention window; without
		// one, everything up to the current revision is prunable.
		var first sql.NullInt64
		if err := tx.QueryRowContext(ctx,
			`SELECT MIN(seq) FROM operations WHERE seq IS NOT NULL AND created_at >= ?`, cutoff).Scan(&first); err != nil {
			return fmt.Errorf("finding retained history: %w", err)
		}
		minRev := r.revision + 1
		if first.Valid {
			minRev = first.Int64
		}
		minRev = max(minRev, r.minRevision)

		res, err := tx.ExecContext(ctx,
			`DELETE FROM operations WHERE seq < ? OR (seq IS NULL AND created_at < ?)`, minRev, cutoff)
		if err != nil {
			return fmt.Errorf("pruning operations: %w", err)
		}
		if out.Operations, err = res.RowsAffected(); err != nil {
			return fmt.Errorf("pruning operations: %w", err)
		}
		res, err = tx.ExecContext(ctx,
			`DELETE FROM entries WHERE closed_revision IS NOT NULL AND closed_revision < ?`, minRev)
		if err != nil {
			return fmt.Errorf("pruning tombstones: %w", err)
		}
		if out.Tombstones, err = res.RowsAffected(); err != nil {
			return fmt.Errorf("pruning tombstones: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE session SET min_revision = ? WHERE id = 1`, minRev); err != nil {
			return fmt.Errorf("updating min revision: %w", err)
		}
		out.MinRevision = minRev
		return nil
	})
	return out, err
}

// RunPruner prunes once immediately and then on every tick until ctx is
// done. now supplies the clock. Failures are logged and retried on the next
// tick.
func (s *Store) RunPruner(ctx context.Context, ticks <-chan time.Time, retention time.Duration, now func() time.Time, log *slog.Logger) {
	for {
		res, err := s.Prune(ctx, now(), retention)
		switch {
		case err != nil && ctx.Err() == nil:
			log.LogAttrs(ctx, slog.LevelError, "pruning history failed", slog.String("error", err.Error()))
		case err == nil && res.Operations+res.Tombstones > 0:
			log.LogAttrs(ctx, slog.LevelInfo, "pruned history",
				slog.Int64("operations", res.Operations), slog.Int64("tombstones", res.Tombstones),
				slog.Int64("min_revision", res.MinRevision))
		}
		select {
		case <-ctx.Done():
			return
		case <-ticks:
		}
	}
}
