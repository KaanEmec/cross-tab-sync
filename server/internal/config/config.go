// Package config loads service configuration from environment variables.
package config

import (
	"fmt"
	"strconv"
	"time"
)

// Config holds the service settings. Zero values are never used; call Load.
type Config struct {
	Addr              string        // CTS_ADDR
	DBPath            string        // CTS_DB_PATH
	AllowInsecure     bool          // CTS_ALLOW_INSECURE
	OwnerLiveness     time.Duration // CTS_OWNER_LIVENESS
	SnapshotRetention int           // CTS_SNAPSHOT_RETENTION
}

// Default returns the configuration used when no variables are set.
func Default() Config {
	return Config{
		Addr:              ":8080",
		DBPath:            "./data/cts.db",
		OwnerLiveness:     10 * time.Minute,
		SnapshotRetention: 20,
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
	return c, nil
}
