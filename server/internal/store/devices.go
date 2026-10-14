package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
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
	MaxLiveCodes = 10 // per session; a new code replaces the oldest live one
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

// uniqueName returns name unchanged when no other active device of session
// sid (exceptID aside) uses it, ignoring case. Otherwise it appends the
// lowest free " N" (N >= 2), shortening the base so the result stays within
// session.MaxNameLength runes.
func uniqueName(ctx context.Context, tx *sql.Tx, sid int64, name, exceptID string) (string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT name FROM devices WHERE session_id = ? AND revoked_at IS NULL AND id != ?`, sid, exceptID)
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

// CreatePairingCode stores a new single-use code for the session of the
// active device createdBy and returns it with its expiry. A session keeps at
// most MaxLiveCodes live codes: the oldest beyond that are deleted.
func (s *Store) CreatePairingCode(ctx context.Context, createdBy string, now time.Time) (string, time.Time, error) {
	code, err := newCode()
	if err != nil {
		return "", time.Time{}, err
	}
	expires := now.Add(CodeTTL)
	err = s.tx(ctx, func(tx *sql.Tx) error {
		sid, err := requireActiveDevice(ctx, tx, createdBy)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM pairing_codes WHERE expires_at <= ?`, ms(now)); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO pairing_codes (code_hash, session_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
			hash(code), sid, createdBy, ms(now), ms(expires)); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM pairing_codes WHERE session_id = ?1 AND used_at IS NULL AND rowid NOT IN
			(SELECT rowid FROM pairing_codes WHERE session_id = ?1 AND used_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?2)`,
			sid, MaxLiveCodes)
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

// newToken returns a fresh bearer token; only its hash is stored.
func newToken() string {
	raw := make([]byte, 32)
	_, _ = rand.Read(raw) // crypto/rand.Read never returns an error
	return TokenPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

// addDevice registers a new device with token in session sid. The name gets
// a numeric suffix when another active device of the session already uses
// it (uniqueName).
func addDevice(ctx context.Context, tx *sql.Tx, sid int64, name, browser, token string, now time.Time) (Device, error) {
	id := uuid.NewString()
	name, err := uniqueName(ctx, tx, sid, name, id)
	if err != nil {
		return Device{}, err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO devices (id, session_id, name, browser, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, sid, name, browser, hash(token), ms(now), ms(now)); err != nil {
		return Device{}, fmt.Errorf("adding device: %w", err)
	}
	at := fromMS(ms(now))
	return Device{ID: id, Name: name, Browser: browser, CreatedAt: at, LastSeenAt: at}, nil
}

// CreateSession creates a session with keyCheck and its first device, and
// returns the device and its bearer token. With maxSessions > 0 it fails with
// ErrSessionsClosed once that many sessions exist.
func (s *Store) CreateSession(ctx context.Context, keyCheck, name, browser string, now time.Time, maxSessions int) (Device, string, error) {
	token := newToken()
	var dev Device
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if maxSessions > 0 {
			var n int
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM sessions`).Scan(&n); err != nil {
				return err
			}
			if n >= maxSessions {
				return ErrSessionsClosed
			}
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO sessions (key_check, created_at) VALUES (?, ?)`, keyCheck, ms(now))
		if err != nil {
			return err
		}
		sid, err := res.LastInsertId()
		if err != nil {
			return err
		}
		dev, err = addDevice(ctx, tx, sid, name, browser, token, now)
		return err
	})
	if errors.Is(err, ErrSessionsClosed) {
		return Device{}, "", err
	}
	if err != nil {
		return Device{}, "", fmt.Errorf("creating session: %w", err)
	}
	return dev, token, nil
}

// Pair consumes a pairing code and registers a device in the code's session.
// It returns the new device and its bearer token. It fails with
// ErrSessionFull, leaving the code unused, when the session already has
// maxDevices active devices.
func (s *Store) Pair(ctx context.Context, code, name, browser string, now time.Time, maxDevices int) (Device, string, error) {
	want := hash(NormalizeCode(code))
	token := newToken()
	var dev Device
	err := s.tx(ctx, func(tx *sql.Tx) error {
		// Codes are random and stored as SHA-256 hashes: an indexed lookup
		// reveals nothing a constant-time scan would hide.
		var sid int64
		err := tx.QueryRowContext(ctx, `SELECT session_id FROM pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
			want, ms(now)).Scan(&sid)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrInvalidCode
		}
		if err != nil {
			return err
		}
		var active int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM devices WHERE session_id = ? AND revoked_at IS NULL`, sid).
			Scan(&active); err != nil {
			return err
		}
		if active >= maxDevices {
			return ErrSessionFull
		}
		if _, err := tx.ExecContext(ctx, `UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?`, ms(now), want); err != nil {
			return err
		}
		dev, err = addDevice(ctx, tx, sid, name, browser, token, now)
		return err
	})
	if errors.Is(err, ErrInvalidCode) || errors.Is(err, ErrSessionFull) {
		return Device{}, "", err
	}
	if err != nil {
		return Device{}, "", fmt.Errorf("pairing device: %w", err)
	}
	return dev, token, nil
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

// ListDevices returns the devices of the session of deviceID: active ones
// (oldest first), then those revoked within RevokedListWindow before now
// (most recently revoked first).
func (s *Store) ListDevices(ctx context.Context, deviceID string, now time.Time) ([]Device, error) {
	var out []Device
	err := s.tx(ctx, func(tx *sql.Tx) error {
		sid, err := requireActiveDevice(ctx, tx, deviceID)
		if err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx,
			`SELECT id, name, browser, created_at, last_seen_at, revoked_at FROM devices
			WHERE session_id = ? AND (revoked_at IS NULL OR revoked_at > ?)
			ORDER BY revoked_at IS NOT NULL, revoked_at DESC, created_at, id`, sid, ms(now.Add(-RevokedListWindow)))
		if err != nil {
			return fmt.Errorf("listing devices: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var (
				d                 Device
				created, lastSeen int64
				revoked           sql.NullInt64
			)
			if err := rows.Scan(&d.ID, &d.Name, &d.Browser, &created, &lastSeen, &revoked); err != nil {
				return fmt.Errorf("scanning device: %w", err)
			}
			d.CreatedAt, d.LastSeenAt = fromMS(created), fromMS(lastSeen)
			if revoked.Valid {
				d.RevokedAt = fromMS(revoked.Int64)
			}
			out = append(out, d)
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("listing devices: %w", err)
		}
		return nil
	})
	return out, err
}

// RenameDevice renames the active device id, suffixing the name like Pair
// when another active device already uses it. It returns the updated device.
func (s *Store) RenameDevice(ctx context.Context, id, name string) (Device, error) {
	var d Device
	err := s.tx(ctx, func(tx *sql.Tx) error {
		sid, err := requireActiveDevice(ctx, tx, id)
		if err != nil {
			return err
		}
		unique, err := uniqueName(ctx, tx, sid, name, id)
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

// RevokeDevice revokes device id of the caller's session on behalf of
// callerID (which may be the same device) and clears ownership if id was the
// owner. Revoking the session's last active device deletes the session with
// all its rows. Returns ErrNotFound for unknown or already revoked devices
// and devices of other sessions.
func (s *Store) RevokeDevice(ctx context.Context, callerID, id string, now time.Time) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		sid, err := requireActiveDevice(ctx, tx, callerID)
		if err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `UPDATE devices SET revoked_at = ? WHERE id = ? AND session_id = ? AND revoked_at IS NULL`,
			ms(now), id, sid)
		if err != nil {
			return fmt.Errorf("revoking device: %w", err)
		}
		if n, err := res.RowsAffected(); err != nil {
			return fmt.Errorf("revoking device: %w", err)
		} else if n == 0 {
			return ErrNotFound
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE sessions SET owner_device_id = NULL, owner_last_seen_at = NULL WHERE id = ? AND owner_device_id = ?`, sid, id); err != nil {
			return fmt.Errorf("clearing ownership: %w", err)
		}
		// Nobody can reach a session without an active device: drop it.
		if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE id = ?1 AND NOT EXISTS
			(SELECT 1 FROM devices WHERE session_id = ?1 AND revoked_at IS NULL)`, sid); err != nil {
			return fmt.Errorf("deleting session: %w", err)
		}
		return nil
	})
}
