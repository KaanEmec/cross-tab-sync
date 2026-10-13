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
	if c != Default() {
		t.Fatalf("defaults: got %+v", c)
	}

	c, err = Load(env(map[string]string{
		"CTS_ADDR":               "127.0.0.1:9000",
		"CTS_DB_PATH":            "/data/x.db",
		"CTS_ALLOW_INSECURE":     "1",
		"CTS_OWNER_LIVENESS":     "90s",
		"CTS_SNAPSHOT_RETENTION": "5",
	}))
	if err != nil {
		t.Fatal(err)
	}
	want := Config{Addr: "127.0.0.1:9000", DBPath: "/data/x.db", AllowInsecure: true, OwnerLiveness: 90 * time.Second, SnapshotRetention: 5}
	if c != want {
		t.Fatalf("got %+v, want %+v", c, want)
	}

	for _, bad := range []map[string]string{
		{"CTS_ALLOW_INSECURE": "maybe"},
		{"CTS_OWNER_LIVENESS": "-1m"},
		{"CTS_OWNER_LIVENESS": "ten"},
		{"CTS_SNAPSHOT_RETENTION": "0"},
	} {
		if _, err := Load(env(bad)); err == nil {
			t.Errorf("Load(%v): expected error", bad)
		}
	}
}
