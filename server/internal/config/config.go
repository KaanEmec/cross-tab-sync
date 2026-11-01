// Package config loads service configuration from environment variables.
package config

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Config holds the service settings. Zero values are never used; call Load.
type Config struct {
	Addr              string        // CTS_ADDR
	DBPath            string        // CTS_DB_PATH
	AllowInsecure     bool          // CTS_ALLOW_INSECURE
	OwnerLiveness     time.Duration // CTS_OWNER_LIVENESS
	SnapshotRetention int           // CTS_SNAPSHOT_RETENTION
	HistoryRetention  time.Duration // CTS_HISTORY_RETENTION
	SessionRetention  time.Duration // CTS_SESSION_RETENTION: sessions without device activity this long are deleted
	MaxSessions       int           // CTS_MAX_SESSIONS: 0 = unlimited
	MaxDevices        int           // CTS_MAX_DEVICES: active devices per session
	ClientIPHeader    string        // CTS_CLIENT_IP_HEADER: header carrying the client IP for the rate limit; "" = X-Forwarded-For
	Debug             bool          // CTS_DEBUG: accept and log client diagnostics (POST /v3/diag); development aid
}

// Default returns the configuration used when no variables are set.
func Default() Config {
	return Config{
		Addr:              ":8080",
		DBPath:            "./data/cts.db",
		OwnerLiveness:     10 * time.Minute,
		SnapshotRetention: 20,
		HistoryRetention:  30 * 24 * time.Hour,
		SessionRetention:  180 * 24 * time.Hour,
		MaxDevices:        10,
	}
}

// Load reads configuration through getenv (usually os.Getenv).
func Load(getenv func(string) string) (Config, error) {
	c := Default()
	if v := getenv("CTS_ADDR"); v != "" {
		c.Addr = v
	}
	if v := getenv("CTS_DB_PATH"); v != "" {
		c.DBPath = v
	}
	if v := getenv("CTS_ALLOW_INSECURE"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return Config{}, fmt.Errorf("CTS_ALLOW_INSECURE: %w", err)
		}
		c.AllowInsecure = b
	}
	if v := getenv("CTS_DEBUG"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return Config{}, fmt.Errorf("CTS_DEBUG: %w", err)
		}
		c.Debug = b
	}
	if v := getenv("CTS_OWNER_LIVENESS"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return Config{}, fmt.Errorf("CTS_OWNER_LIVENESS: %w", err)
		}
		if d <= 0 {
			return Config{}, fmt.Errorf("CTS_OWNER_LIVENESS: must be positive, got %s", d)
		}
		c.OwnerLiveness = d
	}
	if v := getenv("CTS_SNAPSHOT_RETENTION"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return Config{}, fmt.Errorf("CTS_SNAPSHOT_RETENTION: %w", err)
		}
		if n < 1 {
			return Config{}, fmt.Errorf("CTS_SNAPSHOT_RETENTION: must be at least 1, got %d", n)
		}
		c.SnapshotRetention = n
	}
	if v := getenv("CTS_HISTORY_RETENTION"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return Config{}, fmt.Errorf("CTS_HISTORY_RETENTION: %w", err)
		}
		if d <= 0 {
			return Config{}, fmt.Errorf("CTS_HISTORY_RETENTION: must be positive, got %s", d)
		}
		c.HistoryRetention = d
	}
	if v := getenv("CTS_SESSION_RETENTION"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return Config{}, fmt.Errorf("CTS_SESSION_RETENTION: %w", err)
		}
		if d <= 0 {
			return Config{}, fmt.Errorf("CTS_SESSION_RETENTION: must be positive, got %s", d)
		}
		c.SessionRetention = d
	}
	if v := getenv("CTS_MAX_SESSIONS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return Config{}, fmt.Errorf("CTS_MAX_SESSIONS: %w", err)
		}
		if n < 0 {
			return Config{}, fmt.Errorf("CTS_MAX_SESSIONS: must be 0 (unlimited) or more, got %d", n)
		}
		c.MaxSessions = n
	}
	if v := getenv("CTS_MAX_DEVICES"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return Config{}, fmt.Errorf("CTS_MAX_DEVICES: %w", err)
		}
		if n < 1 {
			return Config{}, fmt.Errorf("CTS_MAX_DEVICES: must be at least 1, got %d", n)
		}
		c.MaxDevices = n
	}
	c.ClientIPHeader = strings.TrimSpace(getenv("CTS_CLIENT_IP_HEADER"))
	return c, nil
}
