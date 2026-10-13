package api

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestRoutesRequireToken(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	routes := []struct{ method, path string }{
		{"POST", "/v1/pairing-codes"},
		{"GET", "/v1/devices"},
		{"DELETE", "/v1/devices/00000000-0000-4000-8000-000000000001"},
		{"GET", "/v1/session"},
		{"GET", "/v1/session/changes?since=0"},
		{"POST", "/v1/session/acquire"},
		{"POST", "/v1/session/release"},
		{"POST", "/v1/session/heartbeat"},
		{"POST", "/v1/session/operations"},
		{"GET", "/v1/snapshots"},
		{"POST", "/v1/snapshots/1/restore"},
	}
	for _, rt := range routes {
		t.Run(rt.method+" "+rt.path, func(t *testing.T) {
			var er errorJSON
			if st := e.call(rt.method, rt.path, "", map[string]any{"generation": 1}, &er); st != http.StatusUnauthorized || er.Error != "unauthorized" {
				t.Fatalf("status %d %+v", st, er)
			}
		})
	}
}

func TestRevokeNonOwnerAndSelf(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a, b, c := e.pair("A"), e.pair("B"), e.pair("C")
	gen := e.acquire(a, false)

	e.expect(http.StatusNoContent, "DELETE", "/v1/devices/"+b.ID, a.Token, nil, nil)
	if s := e.session(a); s.Owner == nil || s.Owner.DeviceID != a.ID || s.Owner.Generation != gen {
		t.Fatalf("revoking a non-owner changed ownership: %+v", s.Owner)
	}

	e.expect(http.StatusNoContent, "DELETE", "/v1/devices/"+c.ID, c.Token, nil, nil)
	var er errorJSON
	e.expect(http.StatusUnauthorized, "POST", "/v1/pairing-codes", c.Token, nil, &er)
	if er.Error != "device_revoked" {
		t.Fatalf("self-revoked device: %+v", er)
	}
}

var msTimestamp = regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$`)

func TestTimestampsHaveMilliseconds(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil) // clock sits on a whole second: default encoding would drop ".000"
	a := e.pair("A")
	gen := e.acquire(a, false)
	e1 := uid()
	e.ops(a, gen, 0, openOp(e1, "https://a.example/"))
	e.ops(a, gen, 1, op{"opId": uid(), "type": "close", "entryId": e1})

	var acq struct {
		Session struct {
			Owner struct {
				LastSeenAt string `json:"lastSeenAt"`
			} `json:"owner"`
		} `json:"session"`
	}
	e.expect(http.StatusOK, "POST", "/v1/session/acquire", a.Token, nil, &acq)
	var pc struct {
		ExpiresAt string `json:"expiresAt"`
	}
	e.expect(http.StatusCreated, "POST", "/v1/pairing-codes", a.Token, nil, &pc)
	var devs struct {
		Devices []struct {
			CreatedAt  string `json:"createdAt"`
			LastSeenAt string `json:"lastSeenAt"`
		} `json:"devices"`
	}
	e.expect(http.StatusOK, "GET", "/v1/devices", a.Token, nil, &devs)
	var snaps struct {
		Snapshots []struct {
			CreatedAt string `json:"createdAt"`
		} `json:"snapshots"`
	}
	e.expect(http.StatusOK, "GET", "/v1/snapshots", a.Token, nil, &snaps)

	got := map[string]string{
		"owner.lastSeenAt":   acq.Session.Owner.LastSeenAt,
		"expiresAt":          pc.ExpiresAt,
		"device.createdAt":   devs.Devices[0].CreatedAt,
		"device.lastSeenAt":  devs.Devices[0].LastSeenAt,
		"snapshot.createdAt": snaps.Snapshots[0].CreatedAt,
	}
	for name, v := range got {
		if !msTimestamp.MatchString(v) {
			t.Errorf("%s = %q, want RFC 3339 UTC with milliseconds", name, v)
		}
	}
	if got["owner.lastSeenAt"] != "2026-01-01T12:00:00.000Z" {
		t.Errorf("owner.lastSeenAt = %q", got["owner.lastSeenAt"])
	}
}

func TestPositionBound(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a := e.pair("A")
	gen := e.acquire(a, false)
	o := openOp(uid(), "https://a.example/")
	o["position"] = int64(1 << 53)
	var er errorJSON
	e.expect(http.StatusBadRequest, "POST", "/v1/session/operations", a.Token,
		map[string]any{"generation": gen, "baseRevision": 0, "operations": []op{o}}, &er)
	if er.Error != "invalid_request" {
		t.Fatalf("%+v", er)
	}
	o["position"] = int64(1<<53 - 1)
	e.ops(a, gen, 0, o)
}

func TestLogUsesRoutePattern(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a := e.pair("A")
	e.call("DELETE", "/v1/devices/weird-segment-https:%2F%2Fleak.example", a.Token, nil, nil)
	logs := e.logs.String()
	if strings.Contains(logs, "weird-segment") || strings.Contains(logs, "leak.example") {
		t.Fatalf("log contains client path segment:\n%s", logs)
	}
	if !strings.Contains(logs, `"path":"/v1/devices/{id}"`) {
		t.Fatalf("log missing route pattern:\n%s", logs)
	}
}

func TestRestoreRetryIsReplay(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a := e.pair("A")
	gen := e.acquire(a, false)
	e1, e2 := uid(), uid()
	e.ops(a, gen, 0, openOp(e1, "https://a.example/"), openOp(e2, "https://b.example/"))
	e.ops(a, gen, 2, op{"opId": uid(), "type": "close", "entryId": e2})

	path := "/v1/snapshots/1/restore"
	var first, second opsResp
	e.expect(http.StatusOK, "POST", path, a.Token, map[string]int64{"generation": gen}, &first)
	e.expect(http.StatusOK, "POST", path, a.Token, map[string]int64{"generation": gen}, &second)
	if second.Revision != first.Revision || len(second.Results) != len(first.Results) {
		t.Fatalf("retry changed state: %+v -> %+v", first, second)
	}
	for i, r := range second.Results {
		if !r.Replayed || r.OpID != first.Results[i].OpID || r.Status != first.Results[i].Status || r.EntryID != first.Results[i].EntryID {
			t.Fatalf("retry result %d = %+v, first %+v", i, r, first.Results[i])
		}
	}
	var snaps struct {
		Snapshots []json.RawMessage `json:"snapshots"`
	}
	e.expect(http.StatusOK, "GET", "/v1/snapshots", a.Token, nil, &snaps)
	if len(snaps.Snapshots) != 2 { // the close snapshot + one pre-restore snapshot
		t.Fatalf("snapshots after retried restore: %d", len(snaps.Snapshots))
	}
}

func TestTombstoneAcrossBatches(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a := e.pair("A")
	gen := e.acquire(a, false)
	e1 := uid()
	e.ops(a, gen, 0, openOp(e1, "https://a.example/"), op{"opId": uid(), "type": "close", "entryId": e1})

	// A stale device later replays an old view of e1 with new opIds.
	r := e.ops(a, gen, 0,
		openOp(e1, "https://a.example/"),
		op{"opId": uid(), "type": "navigate", "entryId": e1, "url": "https://b.example/"},
		op{"opId": uid(), "type": "update", "entryId": e1, "pinned": true},
	)
	for i, res := range r.Results {
		if res.Status != "ignored" || res.Replayed {
			t.Fatalf("op %d on tombstone: %+v", i, res)
		}
	}
	if r.Revision != 2 || len(e.session(a).Entries) != 0 {
		t.Fatalf("tombstone reopened: revision %d", r.Revision)
	}
}

func TestReplayEdgeCases(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a := e.pair("A")
	gen := e.acquire(a, false)
	snapshotCount := func() int {
		var s struct {
			Snapshots []json.RawMessage `json:"snapshots"`
		}
		e.expect(http.StatusOK, "GET", "/v1/snapshots", a.Token, nil, &s)
		return len(s.Snapshots)
	}

	// Duplicate opId inside one batch: the second is a replay of the first.
	dup := openOp(uid(), "https://a.example/")
	r := e.ops(a, gen, 0, dup, dup)
	if r.Revision != 1 || r.Results[0].Replayed || !r.Results[1].Replayed || r.Results[1].Status != "applied" ||
		r.Results[1].EntryID != r.Results[0].EntryID {
		t.Fatalf("duplicate in batch: %+v", r)
	}

	// Replaying an ignored op returns ignored, flagged, with no state change.
	ign := op{"opId": uid(), "type": "close", "entryId": uid()}
	r = e.ops(a, gen, 1, ign)
	if r.Results[0].Status != "ignored" || r.Revision != 1 {
		t.Fatalf("ignored: %+v", r)
	}
	r = e.ops(a, gen, 1, ign)
	if r.Results[0].Status != "ignored" || !r.Results[0].Replayed || r.Revision != 1 {
		t.Fatalf("ignored replay: %+v", r)
	}

	// Close the entry (one more snapshot), then a batch mixing that replayed
	// close with a new open must not add a snapshot.
	before := snapshotCount()
	cl := op{"opId": uid(), "type": "close", "entryId": dup["entryId"]}
	e.ops(a, gen, 1, cl)
	if n := snapshotCount(); n != before+1 {
		t.Fatalf("snapshots after close: %d, want %d", n, before+1)
	}
	r = e.ops(a, gen, 2, cl, openOp(uid(), "https://b.example/"))
	if !r.Results[0].Replayed || r.Results[1].Status != "applied" || r.Revision != 3 {
		t.Fatalf("mixed batch: %+v", r)
	}
	if n := snapshotCount(); n != before+1 {
		t.Fatalf("mixed replay batch added a snapshot: %d", n)
	}
}

func TestOperationsRefreshOwnerLiveness(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil) // liveness 10m
	a, b := e.pair("A"), e.pair("B")
	gen := e.acquire(a, false)

	e.clock.Advance(8 * time.Minute)
	e.ops(a, gen, 0, openOp(uid(), "https://a.example/"))
	s := e.session(a)
	if !s.Owner.LastSeenAt.Equal(e.clock.Now()) {
		t.Fatalf("lastSeenAt %s, want %s", s.Owner.LastSeenAt, e.clock.Now())
	}
	e.clock.Advance(8 * time.Minute) // 16m since acquire, 8m since operations
	var er errorJSON
	e.expect(http.StatusConflict, "POST", "/v1/session/acquire", b.Token, nil, &er)
	if er.Error != "owner_active" {
		t.Fatalf("%+v", er)
	}
	e.clock.Advance(3 * time.Minute)
	if g := e.acquire(b, false); g != gen+1 {
		t.Fatalf("takeover generation %d", g)
	}
}
