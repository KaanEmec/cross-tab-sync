// Package config loads service configuration from environment variables.
package config

import (
	"fmt"
	"net/url"
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
	PublicURL         string        // CTS_PUBLIC_URL, e.g. https://tabs.example.com (no trailing slash); "" when unset
	Debug             bool          // CTS_DEBUG: accept and log client diagnostics (POST /v1/diag); development aid
}

// Default returns the configuration used when no variables are set.
func Default() Config {
	return Config{
		Addr:              ":8080",
		DBPath:            "./data/cts.db",
		OwnerLiveness:     10 * time.Minute,
		SnapshotRetention: 20,
		HistoryRetention:  30 * 24 * time.Hour,
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
	if v := getenv("CTS_PUBLIC_URL"); v != "" {
		u, err := parsePublicURL(v)
		if err != nil {
			return Config{}, fmt.Errorf("CTS_PUBLIC_URL: %w", err)
		}
		c.PublicURL = u
	}
	return c, nil
}

// parsePublicURL accepts an absolute http(s) URL without query or fragment and
// returns it without a trailing slash.
func parsePublicURL(v string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(v))
	if err != nil {
		return "", err
	}
	if (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return "", fmt.Errorf("must be an absolute http(s) URL, got %q", v)
	}
	if u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return "", fmt.Errorf("must not contain credentials, a query or a fragment, got %q", v)
	}
	return strings.TrimRight(u.Scheme+"://"+u.Host+u.EscapedPath(), "/"), nil
}
