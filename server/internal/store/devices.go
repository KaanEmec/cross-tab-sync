package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/kaanemec/cross-tab-sync/server/internal/session"
)

// Pairing and token parameters.
const (
	CodeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789" // no 0/O, 1/I/L
	CodeLength   = 8
	CodeTTL      = 10 * time.Minute
	TokenPrefix  = "cts_"

	// RevokedListWindow is how long a revoked device stays in ListDevices.
	RevokedListWindow = 7 * 24 * time.Hour

	lastSeenResolution = time.Minute
)

// Device is a paired browser. RevokedAt is zero for active devices.
type Device struct {
	ID         string
	Name       string
	Browser    string
	CreatedAt  time.Time
	LastSeenAt time.Time
	RevokedAt  time.Time
}

// uniqueName returns name unchanged when no other active device (exceptID
// aside) uses it, ignoring case. Otherwise it appends the lowest free " N"
// (N >= 2), shortening the base so the result stays within
// session.MaxNameLength runes.
func uniqueName(ctx context.Context, tx *sql.Tx, name, exceptID string) (string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT name FROM devices WHERE revoked_at IS NULL AND id != ?`, exceptID)
	if err != nil {
		return "", fmt.Errorf("listing device names: %w", err)
	}
	defer rows.Close()
	taken := map[string]bool{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return "", fmt.Errorf("scanning device name: %w", err)
		}
		taken[strings.ToLower(n)] = true
	}
	if err := rows.Err(); err != nil {
		return "", fmt.Errorf("listing device names: %w", err)
	}
	if !taken[strings.ToLower(name)] {
		return name, nil
	}
	base := []rune(name)
	for n := 2; ; n++ {
		suffix := " " + strconv.Itoa(n)
		b := base
		if keep := session.MaxNameLength - len(suffix); len(b) > keep {
			b = b[:keep]
		}
		candidate := strings.TrimRight(string(b), " ") + suffix
		if !taken[strings.ToLower(candidate)] {
			return candidate, nil
		}
	}
}

func newCode() (string, error) {
	b := make([]byte, CodeLength)
	limit := big.NewInt(int64(len(CodeAlphabet)))
	for i := range b {
		n, err := rand.Int(rand.Reader, limit)
		if err != nil {
			return "", fmt.Errorf("generating pairing code: %w", err)
		}
		b[i] = CodeAlphabet[n.Int64()]
	}
	return string(b), nil
}

// NormalizeCode uppercases a user-typed code and drops spaces and dashes.
func NormalizeCode(code string) string {
	return strings.Map(func(r rune) rune {
		if r == ' ' || r == '-' {
			return -1
		}
		return r
	}, strings.ToUpper(code))
}

func hash(s string) []byte {
	h := sha256.Sum256([]byte(s))
	return h[:]
}

// CreatePairingCode stores a new single-use code and returns it with its
// expiry. createdBy is the creating device id, or "" for the CLI.
func (s *Store) CreatePairingCode(ctx context.Context, createdBy string, now time.Time) (string, time.Time, error) {
	code, err := newCode()
	if err != nil {
		return "", time.Time{}, err
	}
	expires := now.Add(CodeTTL)
	var by any
	if createdBy != "" {
		by = createdBy
	}
	err = s.tx(ctx, func(tx *sql.Tx) error {
		if createdBy != "" {
			if err := requireActiveDevice(ctx, tx, createdBy); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM pairing_codes WHERE expires_at <= ?`, ms(now)); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx,
			`INSERT INTO pairing_codes (code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)`,
			hash(code), by, ms(now), ms(expires))
		return err
	})
	if errors.Is(err, ErrRevoked) {
		return "", time.Time{}, err
	}
	if err != nil {
		return "", time.Time{}, fmt.Errorf("storing pairing code: %w", err)
	}
	return code, fromMS(ms(expires)), nil
}

// Pair consumes a pairing code and registers a device. It returns the new
// device and its bearer token; only the token hash is stored. The name gets a
// numeric suffix when another active device already uses it (uniqueName).
func (s *Store) Pair(ctx context.Context, code, name, browser string, now time.Time) (Device, string, error) {
	want := hash(NormalizeCode(code))
	id := uuid.NewString()
	raw := make([]byte, 32)
	_, _ = rand.Read(raw) // crypto/rand.Read never returns an error
	token := TokenPrefix + base64.RawURLEncoding.EncodeToString(raw)

	err := s.tx(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx,
			`SELECT code_hash FROM pairing_codes WHERE used_at IS NULL AND expires_at > ?`, ms(now))
		if err != nil {
			return err
		}
		var match []byte
		for rows.Next() {
			var h []byte
			if err := rows.Scan(&h); err != nil {
				_ = rows.Close()
				return err
			}
			// Compare against every live code in constant time.
			if subtle.ConstantTimeCompare(h, want) == 1 {
				match = h
			}
		}
		if err := rows.Close(); err != nil {
			return err
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if match == nil {
			return ErrInvalidCode
		}
		if _, err := tx.ExecContext(ctx, `UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?`, ms(now), match); err != nil {
			return err
		}
		if name, err = uniqueName(ctx, tx, name, id); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx,
			`INSERT INTO devices (id, name, browser, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`,
			id, name, browser, hash(token), ms(now), ms(now))
		return err
	})
	if err != nil {
		if errors.Is(err, ErrInvalidCode) {
			return Device{}, "", err
		}
		return Device{}, "", fmt.Errorf("pairing device: %w", err)
	}
	at := fromMS(ms(now))
	return Device{ID: id, Name: name, Browser: browser, CreatedAt: at, LastSeenAt: at}, token, nil
}

// Authenticate resolves a bearer token to its device and refreshes the
// device's lastSeenAt (at most once per minute).
func (s *Store) Authenticate(ctx context.Context, token string, now time.Time) (Device, error) {
	if !strings.HasPrefix(token, TokenPrefix) {
		return Device{}, ErrUnauthorized
	}
	var (
		d                 Device
		created, lastSeen int64
		revoked           sql.NullInt64
	)
	err := s.db.QueryRowContext(ctx,
		`SELECT id, name, browser, created_at, last_seen_at, revoked_at FROM devices WHERE token_hash = ?`,
		hash(token)).Scan(&d.ID, &d.Name, &d.Browser, &created, &lastSeen, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return Device{}, ErrUnauthorized
	}
	if err != nil {
		return Device{}, fmt.Errorf("authenticating: %w", err)
	}
	if revoked.Valid {
		return Device{}, ErrRevoked
	}
	d.CreatedAt, d.LastSeenAt = fromMS(created), fromMS(lastSeen)
	if now.Sub(d.LastSeenAt) >= lastSeenResolution {
		if _, err := s.db.ExecContext(ctx, `UPDATE devices SET last_seen_at = ? WHERE id = ?`, ms(now), d.ID); err != nil {
			return Device{}, fmt.Errorf("updating last seen: %w", err)
		}
		d.LastSeenAt = fromMS(ms(now))
	}
	return d, nil
}

// ListDevices returns active devices (oldest first), then devices revoked
// within RevokedListWindow before now (most recently revoked first).
func (s *Store) ListDevices(ctx context.Context, now time.Time) ([]Device, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, name, browser, created_at, last_seen_at, revoked_at FROM devices
		WHERE revoked_at IS NULL OR revoked_at > ?
		ORDER BY revoked_at IS NOT NULL, revoked_at DESC, created_at, id`, ms(now.Add(-RevokedListWindow)))
	if err != nil {
		return nil, fmt.Errorf("listing devices: %w", err)
	}
	defer rows.Close()
	var out []Device
	for rows.Next() {
		var (
			d                 Device
			created, lastSeen int64
			revoked           sql.NullInt64
		)
		if err := rows.Scan(&d.ID, &d.Name, &d.Browser, &created, &lastSeen, &revoked); err != nil {
			return nil, fmt.Errorf("scanning device: %w", err)
		}
		d.CreatedAt, d.LastSeenAt = fromMS(created), fromMS(lastSeen)
		if revoked.Valid {
			d.RevokedAt = fromMS(revoked.Int64)
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("listing devices: %w", err)
	}
	return out, nil
}

// RenameDevice renames the active device id, suffixing the name like Pair
// when another active device already uses it. It returns the updated device.
func (s *Store) RenameDevice(ctx context.Context, id, name string) (Device, error) {
	var d Device
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if err := requireActiveDevice(ctx, tx, id); err != nil {
			return err
		}
		unique, err := uniqueName(ctx, tx, name, id)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE devices SET name = ? WHERE id = ?`, unique, id); err != nil {
			return fmt.Errorf("renaming device: %w", err)
		}
		var created, lastSeen int64
		err = tx.QueryRowContext(ctx, `SELECT id, name, browser, created_at, last_seen_at FROM devices WHERE id = ?`, id).
			Scan(&d.ID, &d.Name, &d.Browser, &created, &lastSeen)
		if err != nil {
			return fmt.Errorf("reading device: %w", err)
		}
		d.CreatedAt, d.LastSeenAt = fromMS(created), fromMS(lastSeen)
		return nil
	})
	return d, err
}

// RevokeDevice revokes device id on behalf of callerID (which may be the same
// device) and clears ownership if id was the owner. Returns ErrNotFound for
// unknown or already revoked devices.
func (s *Store) RevokeDevice(ctx context.Context, callerID, id string, now time.Time) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := requireActiveDevice(ctx, tx, callerID); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, ms(now), id)
		if err != nil {
			return fmt.Errorf("revoking device: %w", err)
		}
		if n, err := res.RowsAffected(); err != nil {
			return fmt.Errorf("revoking device: %w", err)
		} else if n == 0 {
			return ErrNotFound
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE session SET owner_device_id = NULL, owner_last_seen_at = NULL WHERE id = 1 AND owner_device_id = ?`, id); err != nil {
			return fmt.Errorf("clearing ownership: %w", err)
		}
		return nil
	})
}
