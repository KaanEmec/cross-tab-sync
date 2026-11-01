package config

import (
	"testing"
	"time"
)

func TestLoad(t *testing.T) {
	t.Parallel()

	env := func(m map[string]string) func(string) string {
		return func(k string) string { return m[k] }
	}

	c, err := Load(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c != Default() || c.HistoryRetention != 720*time.Hour || c.SessionRetention != 4320*time.Hour ||
		c.MaxSessions != 0 || c.MaxDevices != 10 || c.ClientIPHeader != "" {
		t.Fatalf("defaults: got %+v", c)
	}

	c, err = Load(env(map[string]string{
		"CTS_ADDR":               "127.0.0.1:9000",
		"CTS_DB_PATH":            "/data/x.db",
		"CTS_ALLOW_INSECURE":     "1",
		"CTS_OWNER_LIVENESS":     "90s",
		"CTS_SNAPSHOT_RETENTION": "5",
		"CTS_HISTORY_RETENTION":  "48h",
		"CTS_SESSION_RETENTION":  "24h",
		"CTS_MAX_SESSIONS":       "1",
		"CTS_MAX_DEVICES":        "3",
		"CTS_CLIENT_IP_HEADER":   " CF-Connecting-IP ",
		"CTS_DEBUG":              "1",
	}))
	if err != nil {
		t.Fatal(err)
	}
	want := Config{Addr: "127.0.0.1:9000", DBPath: "/data/x.db", AllowInsecure: true, OwnerLiveness: 90 * time.Second, SnapshotRetention: 5, HistoryRetention: 48 * time.Hour,
		SessionRetention: 24 * time.Hour, MaxSessions: 1, MaxDevices: 3, ClientIPHeader: "CF-Connecting-IP", Debug: true}
	if c != want {
		t.Fatalf("got %+v, want %+v", c, want)
	}

	for _, bad := range []map[string]string{
		{"CTS_ALLOW_INSECURE": "maybe"},
		{"CTS_DEBUG": "verbose"},
		{"CTS_OWNER_LIVENESS": "-1m"},
		{"CTS_OWNER_LIVENESS": "ten"},
		{"CTS_SNAPSHOT_RETENTION": "0"},
		{"CTS_HISTORY_RETENTION": "0s"},
		{"CTS_HISTORY_RETENTION": "month"},
		{"CTS_SESSION_RETENTION": "0s"},
		{"CTS_SESSION_RETENTION": "-1h"},
		{"CTS_SESSION_RETENTION": "half a year"},
		{"CTS_MAX_SESSIONS": "-1"},
		{"CTS_MAX_SESSIONS": "many"},
		{"CTS_MAX_DEVICES": "0"},
		{"CTS_MAX_DEVICES": "ten"},
	} {
		if _, err := Load(env(bad)); err == nil {
			t.Errorf("Load(%v): expected error", bad)
		}
	}
}
