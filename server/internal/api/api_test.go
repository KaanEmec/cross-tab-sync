package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kaanemec/cross-tab-sync/server/internal/config"
	"github.com/kaanemec/cross-tab-sync/server/internal/session"
)

func TestHealthzAndHTTPSEnforcement(t *testing.T) {
	t.Parallel()
	e := newEnv(t, func(c *config.Config) { c.AllowInsecure = false })

	var h map[string]string
	e.expect(http.StatusOK, "GET", "/healthz", "", nil, &h)
	if h["status"] != "ok" {
		t.Fatalf("healthz body %v", h)
	}

	var er errorJSON
	e.expect(http.StatusForbidden, "GET", "/v2/session", "", nil, &er)
	if er.Error != "invalid_request" {
		t.Fatalf("plain http: %+v", er)
	}

	req, _ := http.NewRequest("GET", e.srv.URL+"/v2/session", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	resp, err := e.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("forwarded https without token: %d", resp.StatusCode)
	}
}

func TestPairingAndRevocation(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	ctx := context.Background()

	// Single use.
	code, _, err := e.st.CreatePairingCode(ctx, "", e.clock.Now())
	if err != nil {
		t.Fatal(err)
	}
	var a testDevice
	e.expect(http.StatusCreated, "POST", "/v2/pair", "", map[string]string{"code": strings.ToLower(code), "name": "Mac Safari", "browser": "safari"}, &a)
	if !strings.HasPrefix(a.Token, "cts_") || len(a.Token) != 4+43 || a.ID == "" {
		t.Fatalf("pair response %+v", a)
	}
	var er errorJSON
	e.expect(http.StatusBadRequest, "POST", "/v2/pair", "", map[string]string{"code": code, "name": "x", "browser": "brave"}, &er)
	if er.Error != "invalid_code" {
		t.Fatalf("reused code: %+v", er)
	}

	// Expiry after 10 minutes.
	code, _, err = e.st.CreatePairingCode(ctx, "", e.clock.Now())
	if err != nil {
		t.Fatal(err)
	}
	e.clock.Advance(10*time.Minute + time.Second)
	e.expect(http.StatusBadRequest, "POST", "/v2/pair", "", map[string]string{"code": code, "name": "x", "browser": "brave"}, &er)
	if er.Error != "invalid_code" {
		t.Fatalf("expired code: %+v", er)
	}

	// Validation.
	e.expect(http.StatusBadRequest, "POST", "/v2/pair", "", map[string]string{"code": code, "name": " ", "browser": "brave"}, &er)
	if er.Error != "invalid_request" {
		t.Fatalf("empty name: %+v", er)
	}

	// A paired device issues a code for the next one.
	var pc struct {
		Code      string    `json:"code"`
		ExpiresAt time.Time `json:"expiresAt"`
	}
	e.expect(http.StatusCreated, "POST", "/v2/pairing-codes", a.Token, nil, &pc)
	if len(pc.Code) != 8 || !pc.ExpiresAt.Equal(e.clock.Now().Add(10*time.Minute)) {
		t.Fatalf("pairing code %+v", pc)
	}
	var b testDevice
	e.expect(http.StatusCreated, "POST", "/v2/pair", "", map[string]string{"code": pc.Code, "name": "Win Brave", "browser": "brave"}, &b)

	var list struct {
		Devices []struct {
			ID     string `json:"id"`
			Name   string `json:"name"`
			IsSelf bool   `json:"isSelf"`
		} `json:"devices"`
	}
	e.expect(http.StatusOK, "GET", "/v2/devices", b.Token, nil, &list)
	if len(list.Devices) != 2 || list.Devices[0].ID != a.ID || list.Devices[0].IsSelf || !list.Devices[1].IsSelf {
		t.Fatalf("devices %+v", list)
	}

	// Unauthorized variants.
	for _, tok := range []string{"", "cts_nope", "garbage"} {
		e.expect(http.StatusUnauthorized, "GET", "/v2/session", tok, nil, &er)
		if er.Error != "unauthorized" {
			t.Fatalf("token %q: %+v", tok, er)
		}
	}

	// Revoking the owner clears ownership; the revoked device gets device_revoked.
	e.acquire(a, false)
	e.expect(http.StatusNoContent, "DELETE", "/v2/devices/"+a.ID, b.Token, nil, nil)
	e.expect(http.StatusUnauthorized, "GET", "/v2/session", a.Token, nil, &er)
	if er.Error != "device_revoked" {
		t.Fatalf("revoked: %+v", er)
	}
	if s := e.session(b); s.Owner != nil {
		t.Fatalf("owner after revocation: %+v", s.Owner)
	}
	e.expect(http.StatusNotFound, "DELETE", "/v2/devices/"+a.ID, b.Token, nil, &er)
	if er.Error != "not_found" {
		t.Fatalf("double revoke: %+v", er)
	}
	// The revoked device stays listed (with revokedAt) for 7 days, after the active ones.
	e.expect(http.StatusOK, "GET", "/v2/devices", b.Token, nil, &list)
	if len(list.Devices) != 2 || list.Devices[0].ID != b.ID || list.Devices[1].ID != a.ID {
		t.Fatalf("devices after revoke %+v", list)
	}
}

func TestAcquireReleaseHeartbeat(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil) // liveness 10m
	a, b := e.pair("A"), e.pair("B")

	if g := e.acquire(a, false); g != 1 {
		t.Fatalf("first acquire generation %d", g)
	}
	if g := e.acquire(a, false); g != 1 {
		t.Fatalf("re-acquire by owner changed generation to %d", g)
	}

	var er errorJSON
	e.expect(http.StatusConflict, "POST", "/v2/session/acquire", b.Token, map[string]bool{}, &er)
	if er.Error != "owner_active" || er.Owner == nil || er.Owner.DeviceID != a.ID || er.Owner.Generation != 1 || er.Owner.Name != "A" {
		t.Fatalf("owner_active: %+v", er)
	}

	// Heartbeat keeps the owner live.
	e.clock.Advance(9 * time.Minute)
	e.expect(http.StatusNoContent, "POST", "/v2/session/heartbeat", a.Token, map[string]int64{"generation": 1}, nil)
	e.clock.Advance(9 * time.Minute)
	e.expect(http.StatusConflict, "POST", "/v2/session/acquire", b.Token, nil, &er)

	// Liveness expired: takeover without force.
	e.clock.Advance(2 * time.Minute)
	if g := e.acquire(b, false); g != 2 {
		t.Fatalf("takeover generation %d", g)
	}
	e.expect(http.StatusConflict, "POST", "/v2/session/heartbeat", a.Token, map[string]int64{"generation": 1}, &er)
	if er.Error != "stale_owner" || er.Owner.DeviceID != b.ID || er.Owner.Generation != 2 {
		t.Fatalf("stale heartbeat: %+v", er)
	}

	// Force takeover while live.
	if g := e.acquire(a, true); g != 3 {
		t.Fatalf("forced generation %d", g)
	}
	e.expect(http.StatusConflict, "POST", "/v2/session/release", b.Token, map[string]int64{"generation": 2}, &er)
	e.expect(http.StatusConflict, "POST", "/v2/session/release", a.Token, map[string]int64{"generation": 2}, &er)
	e.expect(http.StatusBadRequest, "POST", "/v2/session/release", a.Token, map[string]int64{}, &er)
	e.expect(http.StatusNoContent, "POST", "/v2/session/release", a.Token, map[string]int64{"generation": 3}, nil)
	if s := e.session(a); s.Owner != nil {
		t.Fatalf("owner after release %+v", s.Owner)
	}
	e.expect(http.StatusConflict, "POST", "/v2/session/release", a.Token, map[string]int64{"generation": 3}, &er)
	if er.Error != "stale_owner" || er.Owner != nil {
		t.Fatalf("release without owner: %+v", er)
	}
	if g := e.acquire(b, false); g != 4 {
		t.Fatalf("acquire after release generation %d", g)
	}
}

func TestConcurrentAcquireSingleOwner(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	devs := []testDevice{e.pair("A"), e.pair("B")}

	for round := range 10 {
		var (
			wg       sync.WaitGroup
			mu       sync.Mutex
			statuses = map[int]int{}
			winner   = -1
			gen      int64
			start    = make(chan struct{})
		)
		for i, d := range devs {
			wg.Go(func() {
				<-start
				var r acquireResp
				st := e.call("POST", "/v2/session/acquire", d.Token, map[string]bool{"force": false}, &r)
				mu.Lock()
				defer mu.Unlock()
				statuses[st]++
				if st == http.StatusOK {
					winner, gen = i, r.Generation
				}
			})
		}
		close(start)
		wg.Wait()
		if statuses[http.StatusOK] != 1 || statuses[http.StatusConflict] != 1 {
			t.Fatalf("round %d: statuses %v", round, statuses)
		}
		if gen != int64(round+1) {
			t.Fatalf("round %d: generation %d", round, gen)
		}
		e.expect(http.StatusNoContent, "POST", "/v2/session/release", devs[winner].Token, map[string]int64{"generation": gen}, nil)
	}
}

func TestOperationsSemantics(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a := e.pair("A")
	gen := e.acquire(a, false)

	e1, e2, e3, e4 := uid(), uid(), uid(), uid()
	urlA, urlB := "https://a.example/path?q=1#frag", "https://b.example/"

	// Coalescing on exact URL.
	r := e.ops(a, gen, 0, openOp(e1, urlA), openOp(e2, urlA), openOp(e3, urlB))
	want := []struct{ status, entry string }{{"applied", e1}, {"coalesced", e1}, {"applied", e3}}
	for i, w := range want {
		if r.Results[i].Status != w.status || r.Results[i].EntryID != w.entry {
			t.Fatalf("result %d = %+v, want %+v", i, r.Results[i], w)
		}
	}
	if r.Revision != 3 {
		t.Fatalf("revision %d (coalesced ops count as applied)", r.Revision)
	}

	// Navigate collision: e3 moves onto urlA, which e1 holds.
	nav := navOp(e3, urlA)
	r = e.ops(a, gen, 3, nav)
	if r.Results[0].Status != "coalesced" || r.Results[0].EntryID != e1 {
		t.Fatalf("navigate collision %+v", r.Results[0])
	}
	s := e.session(a)
	if len(s.Entries) != 1 || s.Entries[0].ID != e1 || s.Entries[0].URL() != urlA {
		t.Fatalf("entries after collision %+v", s.Entries)
	}

	// Close produces a tombstone; later ops on it are ignored and the URL is free.
	cl := op{"opId": uid(), "type": "close", "entryId": e1}
	r = e.ops(a, gen, 4, cl,
		op{"opId": uid(), "type": "close", "entryId": e1},
		navOp(e1, urlB),
		openOp(e1, urlA),
		openOp(e4, urlA),
	)
	statuses := []string{"applied", "ignored", "ignored", "ignored", "applied"}
	for i, st := range statuses {
		if r.Results[i].Status != st {
			t.Fatalf("close batch result %d = %+v, want %s", i, r.Results[i], st)
		}
	}
	if r.Revision != 6 {
		t.Fatalf("revision %d, ignored ops must not increment", r.Revision)
	}

	// Replay: same opIds return stored results, flagged, with no state change.
	before := e.session(a)
	r = e.ops(a, gen, 6, cl, nav)
	if r.Revision != 6 || !r.Results[0].Replayed || r.Results[0].Status != "applied" ||
		!r.Results[1].Replayed || r.Results[1].Status != "coalesced" || r.Results[1].EntryID != e1 {
		t.Fatalf("replay %+v", r)
	}
	after := e.session(a)
	if after.Revision != before.Revision || len(after.Entries) != len(before.Entries) || after.Entries[0].ID != e4 {
		t.Fatalf("replay changed state: %+v -> %+v", before, after)
	}

	// Update metadata.
	r = e.ops(a, gen, 6, op{"opId": uid(), "type": "update", "entryId": e4, "pinned": true, "position": 7})
	if r.Results[0].Status != "applied" {
		t.Fatalf("update %+v", r.Results[0])
	}
	s = e.session(a)
	if !s.Entries[0].Pinned || s.Entries[0].Position != 7 || s.Entries[0].UpdatedRevision != 7 {
		t.Fatalf("after update %+v", s.Entries[0])
	}
}

func TestStaleOwnerAndInvalidBatchApplyNothing(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a, b := e.pair("A"), e.pair("B")
	genA := e.acquire(a, false)
	e1 := uid()
	e.ops(a, genA, 0, openOp(e1, "https://a.example/"))
	genB := e.acquire(b, true)
	before := e.session(a)

	late := openOp(uid(), "https://late.example/")
	body := map[string]any{"generation": genA, "baseRevision": 1, "operations": []op{
		late, {"opId": uid(), "type": "close", "entryId": e1},
	}}
	var er errorJSON
	e.expect(http.StatusConflict, "POST", "/v2/session/operations", a.Token, body, &er)
	if er.Error != "stale_owner" || er.Owner == nil || er.Owner.DeviceID != b.ID {
		t.Fatalf("stale write: %+v", er)
	}
	// Right generation, wrong testDevice.
	body["generation"] = genB
	e.expect(http.StatusConflict, "POST", "/v2/session/operations", a.Token, body, &er)

	// A valid op followed by an invalid one rejects the whole batch.
	e.expect(http.StatusBadRequest, "POST", "/v2/session/operations", b.Token, map[string]any{
		"generation": genB, "baseRevision": 1,
		"operations": []op{openOp(uid(), "https://ok.example/"),
			op{"opId": uid(), "type": "open", "entryId": uid(), "urlKey": urlKey("x"), "urlEnc": "not base64url!"}},
	}, &er)

	after := e.session(b)
	if after.Revision != before.Revision || len(after.Entries) != 1 || after.Entries[0].ID != e1 {
		t.Fatalf("rejected batches changed state: %+v -> %+v", before, after)
	}
	var snaps struct {
		Snapshots []any `json:"snapshots"`
	}
	e.expect(http.StatusOK, "GET", "/v2/snapshots", b.Token, nil, &snaps)
	if len(snaps.Snapshots) != 0 {
		t.Fatalf("rejected batch left a snapshot: %+v", snaps)
	}
	// The rejected opId was not recorded: the new owner applies it fresh.
	r := e.ops(b, genB, 1, late)
	if r.Results[0].Status != "applied" || r.Results[0].Replayed {
		t.Fatalf("rejected op was recorded: %+v", r.Results[0])
	}
}

func TestCatchUp(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a, b := e.pair("A"), e.pair("B")

	gen := e.acquire(a, false)
	e.ops(a, gen, 0, openOp(uid(), "https://a1.example/"), openOp(uid(), "https://a2.example/")) // rev 1, 2
	e.expect(http.StatusNoContent, "POST", "/v2/session/release", a.Token, map[string]int64{"generation": gen}, nil)

	gen = e.acquire(b, false)
	bOp := openOp(uid(), "https://b1.example/")
	e.ops(b, gen, 2, bOp, op{"opId": uid(), "type": "close", "entryId": uid()}) // rev 3 + ignored
	e.expect(http.StatusNoContent, "POST", "/v2/session/release", b.Token, map[string]int64{"generation": gen}, nil)

	gen = e.acquire(a, false)
	r := e.ops(a, gen, 2, openOp(uid(), "https://a3.example/"))
	if r.Revision != 4 {
		t.Fatalf("revision %d", r.Revision)
	}
	got := r.CatchUp.Operations
	if len(got) != 1 || got[0].Seq != 3 || got[0].DeviceID != b.ID || got[0].Op["opId"] != bOp["opId"] ||
		unseal(got[0].Op["urlEnc"]) != "https://b1.example/" || got[0].Result.Status != "applied" {
		t.Fatalf("catchUp %+v", got)
	}

	// From revision 0 the caller's own operations are still excluded.
	r = e.ops(a, gen, 0)
	if len(r.CatchUp.Operations) != 1 || r.CatchUp.Operations[0].Seq != 3 {
		t.Fatalf("catchUp from 0: %+v", r.CatchUp.Operations)
	}
}

func TestChanges(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a := e.pair("A")
	gen := e.acquire(a, false)
	e.ops(a, gen, 0, openOp(uid(), "https://a.example/"), op{"opId": uid(), "type": "close", "entryId": uid()}, openOp(uid(), "https://b.example/"))

	var ch struct {
		Revision   int64      `json:"revision"`
		Owner      *ownerJSON `json:"owner"`
		Operations []loggedOp `json:"operations"`
	}
	e.expect(http.StatusOK, "GET", "/v2/session/changes?since=0", a.Token, nil, &ch)
	if ch.Revision != 2 || ch.Owner == nil || len(ch.Operations) != 2 || ch.Operations[0].Seq != 1 || ch.Operations[1].Seq != 2 {
		t.Fatalf("changes %+v", ch)
	}
	e.expect(http.StatusOK, "GET", "/v2/session/changes?since=2", a.Token, nil, &ch)
	if len(ch.Operations) != 0 {
		t.Fatalf("changes at head %+v", ch)
	}
	var er errorJSON
	for _, q := range []string{"3", "-1"} {
		e.expect(http.StatusGone, "GET", "/v2/session/changes?since="+q, a.Token, nil, &er)
		if er.Error != "history_expired" {
			t.Fatalf("since=%s: %+v", q, er)
		}
	}
	e.expect(http.StatusBadRequest, "GET", "/v2/session/changes", a.Token, nil, &er)
}

func TestRestoreSnapshot(t *testing.T) {
	t.Parallel()
	e := newEnv(t, func(c *config.Config) { c.SnapshotRetention = 3 })
	a := e.pair("A")
	gen := e.acquire(a, false)
	e1, e2 := uid(), uid()
	e.ops(a, gen, 0, openOp(e1, "https://keep.example/"), openOp(e2, "https://gone.example/"))
	e.ops(a, gen, 2, op{"opId": uid(), "type": "close", "entryId": e2}) // snapshot of 2 entries

	type snapshot struct {
		ID         int64  `json:"id"`
		Revision   int64  `json:"revision"`
		DeviceID   string `json:"deviceId"`
		Reason     string `json:"reason"`
		EntryCount int    `json:"entryCount"`
	}
	var list struct {
		Snapshots []snapshot `json:"snapshots"`
	}
	e.expect(http.StatusOK, "GET", "/v2/snapshots", a.Token, nil, &list)
	if len(list.Snapshots) != 1 || list.Snapshots[0].EntryCount != 2 || list.Snapshots[0].Revision != 2 ||
		list.Snapshots[0].DeviceID != a.ID || list.Snapshots[0].Reason != "operations" {
		t.Fatalf("snapshots %+v", list)
	}
	id := list.Snapshots[0].ID
	path := "/v2/snapshots/" + strconv.FormatInt(id, 10) + "/restore"

	var er errorJSON
	e.expect(http.StatusConflict, "POST", path, a.Token, map[string]int64{"generation": gen + 1}, &er)
	e.expect(http.StatusNotFound, "POST", "/v2/snapshots/999/restore", a.Token, map[string]int64{"generation": gen}, &er)

	var r opsResp
	e.expect(http.StatusOK, "POST", path, a.Token, map[string]int64{"generation": gen}, &r)
	if r.Revision != 5 || len(r.Results) != 2 {
		t.Fatalf("restore %+v", r)
	}
	statuses := map[string]int{}
	for _, res := range r.Results {
		statuses[res.Status]++
	}
	if statuses["coalesced"] != 1 || statuses["applied"] != 1 {
		t.Fatalf("restore results %+v", r.Results)
	}

	// Restoration is ordinary open ops in the log under the caller.
	var ch struct {
		Operations []loggedOp `json:"operations"`
	}
	e.expect(http.StatusOK, "GET", "/v2/session/changes?since=3", a.Token, nil, &ch)
	if len(ch.Operations) != 2 {
		t.Fatalf("restore ops %+v", ch.Operations)
	}
	for _, o := range ch.Operations {
		if o.Op["type"] != "open" || o.DeviceID != a.ID {
			t.Fatalf("restore op %+v", o)
		}
	}
	s := e.session(a)
	if len(s.Entries) != 2 {
		t.Fatalf("entries after restore %+v", s.Entries)
	}

	// A pre-restore snapshot was saved first.
	e.expect(http.StatusOK, "GET", "/v2/snapshots", a.Token, nil, &list)
	if len(list.Snapshots) != 2 || list.Snapshots[0].Reason != "restore" || list.Snapshots[0].EntryCount != 1 {
		t.Fatalf("snapshots after restore %+v", list)
	}

	// Retention bound.
	for range 4 {
		e.expect(http.StatusOK, "GET", "/v2/snapshots", a.Token, nil, &list)
		latest := "/v2/snapshots/" + strconv.FormatInt(list.Snapshots[0].ID, 10) + "/restore"
		e.expect(http.StatusOK, "POST", latest, a.Token, map[string]int64{"generation": gen}, &r)
	}
	e.expect(http.StatusOK, "GET", "/v2/snapshots", a.Token, nil, &list)
	if len(list.Snapshots) != 3 {
		t.Fatalf("retention: %d snapshots", len(list.Snapshots))
	}
}

func TestLimitsAndValidation(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a := e.pair("A")
	gen := e.acquire(a, false)
	send := func(ops []op) (int, errorJSON) {
		var er errorJSON
		st := e.call("POST", "/v2/session/operations", a.Token, map[string]any{"generation": gen, "baseRevision": 0, "operations": ops}, &er)
		return st, er
	}

	tooMany := make([]op, 501)
	for i := range tooMany {
		tooMany[i] = op{"opId": uid(), "type": "close", "entryId": uid()}
	}
	if st, er := send(tooMany); st != http.StatusRequestEntityTooLarge || er.Error != "payload_too_large" {
		t.Fatalf("501 ops: %d %+v", st, er)
	}

	// Bodies up to 256 KiB: a batch of maximal ciphertexts padded to 200 KiB
	// passes, 300 KiB is rejected before decoding.
	sizedBody := func(size int) []byte {
		ops := make([]op, 45)
		for i := range ops {
			ops[i] = op{"opId": uid(), "type": "open", "entryId": uid(),
				"urlKey": urlKey(fmt.Sprint(i)), "urlEnc": strings.Repeat("A", session.MaxURLEncLen)}
		}
		data, err := json.Marshal(map[string]any{"generation": gen, "baseRevision": 0, "operations": ops})
		if err != nil || len(data) > size {
			t.Fatalf("body %d bytes > %d: %v", len(data), size, err)
		}
		return append(data[:len(data)-1], append(bytes.Repeat([]byte(" "), size-len(data)), '}')...)
	}
	var er errorJSON
	e.expect(http.StatusOK, "POST", "/v2/session/operations", a.Token, sizedBody(200<<10), nil)
	if st := e.call("POST", "/v2/session/operations", a.Token, sizedBody(300<<10), &er); st != http.StatusRequestEntityTooLarge || er.Error != "payload_too_large" {
		t.Fatalf("300 KiB body: %d %+v", st, er)
	}

	before := len(e.session(a).Entries)
	k, enc := sealed("https://a.example/")
	for name, o := range map[string]op{
		"bad op id":       {"opId": "nope", "type": "close", "entryId": uid()},
		"bad type":        {"opId": uid(), "type": "rewind", "entryId": uid()},
		"plaintext url":   {"opId": uid(), "type": "open", "entryId": uid(), "url": "https://a.example/"},
		"sealed plus url": {"opId": uid(), "type": "open", "entryId": uid(), "urlKey": k, "urlEnc": enc, "url": "https://a.example/"},
		"unknown field":   {"opId": uid(), "type": "close", "entryId": uid(), "baseRevision": 0},
		"not an object":   nil,
		"short urlKey":    {"opId": uid(), "type": "open", "entryId": uid(), "urlKey": k[1:], "urlEnc": enc},
		"urlKey alphabet": {"opId": uid(), "type": "navigate", "entryId": uid(), "urlKey": k[1:] + "+", "urlEnc": enc},
		"empty urlEnc":    {"opId": uid(), "type": "open", "entryId": uid(), "urlKey": k, "urlEnc": ""},
		"long urlEnc":     {"opId": uid(), "type": "open", "entryId": uid(), "urlKey": k, "urlEnc": strings.Repeat("A", session.MaxURLEncLen+1)},
		"empty patch":     {"opId": uid(), "type": "update", "entryId": uid()},
	} {
		// A bad operation rejects the whole batch, valid ones included.
		if st, er := send([]op{openOp(uid(), "https://ok.example/"), o}); st != http.StatusBadRequest || er.Error != "invalid_request" {
			t.Errorf("%s: %d %+v", name, st, er)
		}
	}
	if s := e.session(a); len(s.Entries) != before {
		t.Fatalf("rejected batches changed state: %d entries, want %d", len(s.Entries), before)
	}

	e.expect(http.StatusBadRequest, "POST", "/v2/session/operations", a.Token, []byte(`{"generation":1,`), &er)
	e.expect(http.StatusBadRequest, "POST", "/v2/session/operations", a.Token, []byte(`{"generation":1,"baseRevision":0} {}`), &er)
	e.expect(http.StatusBadRequest, "POST", "/v2/session/operations", a.Token, map[string]any{"generation": gen}, &er)
	e.expect(http.StatusNotFound, "GET", "/v2/nope", a.Token, nil, &er)
	if er.Error != "not_found" {
		t.Fatalf("unknown route %+v", er)
	}
}

func TestLogsOmitURLsAndTokens(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	code, _, err := e.st.CreatePairingCode(context.Background(), "", e.clock.Now())
	if err != nil {
		t.Fatal(err)
	}
	var a testDevice
	e.expect(http.StatusCreated, "POST", "/v2/pair", "", map[string]string{"code": code, "name": "A", "browser": "safari"}, &a)
	gen := e.acquire(a, false)
	e.ops(a, gen, 0, openOp(uid(), "https://secret.example/private?token=abc"))
	e.call("GET", "/https://secret.example/x", a.Token, nil, nil)
	e.call("GET", "/v2/session/changes?since=secret.example", a.Token, nil, nil)

	logs := e.logs.String()
	for _, s := range []string{"secret.example", a.Token, code, "cts_"} {
		if strings.Contains(logs, s) {
			t.Fatalf("logs contain %q:\n%s", s, logs)
		}
	}
	if !strings.Contains(logs, `"device_id":"`+a.ID+`"`) || !strings.Contains(logs, `"path":"/v2/session/operations"`) {
		t.Fatalf("logs missing expected fields:\n%s", logs)
	}
}

// v2 replaced v1: the old prefix falls through to the 404 catch-all.
func TestV1RoutesAreGone(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a := e.pair("A")
	for _, r := range []struct{ method, path string }{
		{"GET", "/v1/session"},
		{"POST", "/v1/pair"},
		{"POST", "/v1/session/operations"},
		{"GET", "/v1/devices"},
	} {
		var er errorJSON
		if st := e.call(r.method, r.path, a.Token, map[string]any{}, &er); st != http.StatusNotFound || er.Error != "not_found" {
			t.Errorf("%s %s: %d %+v", r.method, r.path, st, er)
		}
	}
}

// The wire carries urlKey and urlEnc verbatim and never a plaintext url;
// results never echo urlEnc.
func TestSealedURLsOnTheWire(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a := e.pair("A")
	gen := e.acquire(a, false)
	k, enc := sealed("https://a.example/")
	o := openOp(uid(), "https://a.example/")

	raw := func(method, path string, body any) string {
		t.Helper()
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		if body == nil {
			data = nil
		}
		req, err := http.NewRequest(method, e.srv.URL+path, bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+a.Token)
		resp, err := e.srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		out, err := io.ReadAll(resp.Body)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("%s %s: %d %s %v", method, path, resp.StatusCode, out, err)
		}
		return string(out)
	}

	res := raw("POST", "/v2/session/operations", map[string]any{"generation": gen, "baseRevision": 0, "operations": []op{o}})
	if strings.Contains(res, enc) || strings.Contains(res, "urlEnc") {
		t.Fatalf("operations response echoes urlEnc: %s", res)
	}
	var sess map[string]any
	if err := json.Unmarshal([]byte(raw("GET", "/v2/session", nil)), &sess); err != nil {
		t.Fatal(err)
	}
	entries, _ := sess["entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("entries %v", sess["entries"])
	}
	en, _ := entries[0].(map[string]any)
	if _, ok := en["url"]; ok || en["urlKey"] != k || en["urlEnc"] != enc {
		t.Fatalf("session entry %v", en)
	}
	changes := raw("GET", "/v2/session/changes?since=0", nil)
	if !strings.Contains(changes, `"urlKey":"`+k+`"`) || !strings.Contains(changes, `"urlEnc":"`+enc+`"`) || strings.Contains(changes, `"url"`) {
		t.Fatalf("changes %s", changes)
	}
}

func TestKeyCheck(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a, b := e.pair("A"), e.pair("B")
	k1, k2 := urlKey("key one"), urlKey("key two")
	keyCheck := func(path string) any {
		t.Helper()
		var m map[string]any
		e.expect(http.StatusOK, "GET", path, a.Token, nil, &m)
		v, ok := m["keyCheck"]
		if !ok {
			t.Fatalf("%s lacks keyCheck: %v", path, m)
		}
		return v
	}
	if v := keyCheck("/v2/session"); v != nil {
		t.Fatalf("initial keyCheck %v, want null", v)
	}

	var er errorJSON
	for _, bad := range []any{map[string]any{}, map[string]string{"keyCheck": k1[1:]}, map[string]string{"keyCheck": k1[1:] + "="}} {
		e.expect(http.StatusBadRequest, "PUT", "/v2/session/key", a.Token, bad, &er)
	}
	e.expect(http.StatusNoContent, "PUT", "/v2/session/key", a.Token, map[string]string{"keyCheck": k1}, nil)
	e.expect(http.StatusNoContent, "PUT", "/v2/session/key", b.Token, map[string]string{"keyCheck": k1}, nil) // equal: idempotent
	var body map[string]any
	e.expect(http.StatusConflict, "PUT", "/v2/session/key", b.Token, map[string]string{"keyCheck": k2}, &body)
	if len(body) != 2 || body["error"] != "key_set" || body["message"] == nil {
		t.Fatalf("key_set body %v", body)
	}
	if v := keyCheck("/v2/session"); v != k1 {
		t.Fatalf("keyCheck %v, want %s", v, k1)
	}
	var acq struct {
		Session map[string]any `json:"session"`
	}
	e.expect(http.StatusOK, "POST", "/v2/session/acquire", a.Token, nil, &acq)
	if acq.Session["keyCheck"] != k1 {
		t.Fatalf("acquire session keyCheck %v", acq.Session["keyCheck"])
	}

	e.expect(http.StatusNoContent, "DELETE", "/v2/devices/"+b.ID, a.Token, nil, nil)
	e.expect(http.StatusUnauthorized, "PUT", "/v2/session/key", b.Token, map[string]string{"keyCheck": k1}, &er)
	if er.Error != "device_revoked" {
		t.Fatalf("revoked device: %+v", er)
	}
}

// Two first browsers race to store different key checks: exactly one wins.
func TestKeyCheckRace(t *testing.T) {
	t.Parallel()
	for range 5 {
		e := newEnv(t, nil)
		devs := []testDevice{e.pair("A"), e.pair("B")}
		statuses := make([]int, len(devs))
		var wg sync.WaitGroup
		for i, d := range devs {
			wg.Go(func() {
				statuses[i] = e.call("PUT", "/v2/session/key", d.Token, map[string]string{"keyCheck": urlKey(d.ID)}, nil)
			})
		}
		wg.Wait()
		slices.Sort(statuses)
		if !slices.Equal(statuses, []int{http.StatusNoContent, http.StatusConflict}) {
			t.Fatalf("statuses %v, want one 204 and one 409", statuses)
		}
	}
}

// Unknown top-level fields stay ignored; only operation objects are strict.
func TestUnknownTopLevelFieldsIgnored(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a := e.pair("A")
	gen := e.acquire(a, false)
	e.expect(http.StatusOK, "POST", "/v2/session/operations", a.Token,
		map[string]any{"generation": gen, "baseRevision": 0, "operations": []op{openOp(uid(), "https://a.example/")}, "extra": 1}, nil)
	e.expect(http.StatusOK, "POST", "/v2/session/merge", a.Token,
		map[string]any{"operations": []op{at(1, openOp(uid(), "https://b.example/"))}, "extra": 1}, nil)
}
