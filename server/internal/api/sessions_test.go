package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kaanemec/cross-tab-sync/server/internal/config"
)

func TestCreateSession(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	var er errorJSON
	for name, body := range map[string]any{
		"no keyCheck":      map[string]string{"name": "A", "browser": "brave"},
		"short keyCheck":   map[string]string{"keyCheck": testKeyCheck[1:], "name": "A", "browser": "brave"},
		"padded keyCheck":  map[string]string{"keyCheck": testKeyCheck[1:] + "=", "name": "A", "browser": "brave"},
		"empty name":       map[string]string{"keyCheck": testKeyCheck, "name": " ", "browser": "brave"},
		"long name":        map[string]string{"keyCheck": testKeyCheck, "name": strings.Repeat("n", 65), "browser": "brave"},
		"long browser":     map[string]string{"keyCheck": testKeyCheck, "name": "A", "browser": strings.Repeat("b", 33)},
		"not an object":    []byte(`[1]`),
		"keyCheck numeric": map[string]any{"keyCheck": 1, "name": "A", "browser": "brave"},
	} {
		if st := e.call("POST", "/v3/sessions", "", body, &er); st != http.StatusBadRequest || er.Error != "invalid_request" {
			t.Errorf("%s: %d %+v", name, st, er)
		}
	}

	var r pairResp
	e.expect(http.StatusCreated, "POST", "/v3/sessions", "", map[string]string{"keyCheck": testKeyCheck, "name": " Mac ", "browser": "safari"}, &r)
	if !strings.HasPrefix(r.Token, "cts_") || len(r.Token) != 4+43 || r.ID == "" || r.Name != "Mac" {
		t.Fatalf("session response %+v", r)
	}
	s := e.session(r.testDevice)
	if s.Revision != 0 || s.Owner != nil || len(s.Entries) != 0 {
		t.Fatalf("new session %+v", s)
	}
	ds := e.devices(r.testDevice)
	if len(ds) != 1 || ds[0].ID != r.ID || ds[0].Browser != "safari" || !ds[0].IsSelf {
		t.Fatalf("devices of a new session %+v", ds)
	}
	// Names are unique per session only.
	if other := e.start("Mac"); e.devices(other)[0].Name != "Mac" {
		t.Fatalf("name suffixed across sessions: %+v", e.devices(other))
	}
}

func TestMaxSessions(t *testing.T) {
	t.Parallel()
	e := newEnv(t, func(c *config.Config) { c.MaxSessions = 1 })
	a := e.start("A")
	var er errorJSON
	e.expect(http.StatusForbidden, "POST", "/v3/sessions", "", map[string]string{"keyCheck": testKeyCheck, "name": "B", "browser": "brave"}, &er)
	if er.Error != "sessions_closed" {
		t.Fatalf("second session: %+v", er)
	}
	// Invites into the existing session still work.
	e.expect(http.StatusCreated, "POST", "/v3/pair", "", map[string]string{"code": e.invite(a), "name": "B", "browser": "brave"}, nil)
	// Deleting the session (revoking its last device) frees the slot.
	for _, d := range e.devices(a) {
		if !d.IsSelf {
			e.expect(http.StatusNoContent, "DELETE", "/v3/devices/"+d.ID, a.Token, nil, nil)
		}
	}
	e.expect(http.StatusNoContent, "DELETE", "/v3/devices/"+a.ID, a.Token, nil, nil)
	e.start("C")
}

func TestSessionFull(t *testing.T) {
	t.Parallel()
	e := newEnv(t, func(c *config.Config) { c.MaxDevices = 2 })
	a, b := e.pair("A"), e.pair("B")
	code := e.invite(a)
	var er errorJSON
	e.expect(http.StatusForbidden, "POST", "/v3/pair", "", map[string]string{"code": code, "name": "C", "browser": "brave"}, &er)
	if er.Error != "session_full" {
		t.Fatalf("third device: %+v", er)
	}
	// The refused code stays usable once a device is revoked; revoked
	// devices do not count.
	e.expect(http.StatusNoContent, "DELETE", "/v3/devices/"+b.ID, a.Token, nil, nil)
	e.expect(http.StatusCreated, "POST", "/v3/pair", "", map[string]string{"code": code, "name": "C", "browser": "brave"}, nil)
	// The limit is per session.
	other := e.start("X")
	e.expect(http.StatusCreated, "POST", "/v3/pair", "", map[string]string{"code": e.invite(other), "name": "Y", "browser": "brave"}, nil)
}

// Revoking the last active device deletes the session: its devices' tokens
// answer 401 unauthorized, which clients treat like device_revoked.
func TestRevokeLastDeviceDeletesSession(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a, b := e.pair("A"), e.pair("B")
	gen := e.acquire(a, false)
	e.ops(a, gen, 0, openOp(uid(), "https://a.example/"))
	other := e.start("X")

	e.expect(http.StatusNoContent, "DELETE", "/v3/devices/"+b.ID, a.Token, nil, nil)
	if s := e.session(a); len(s.Entries) != 1 {
		t.Fatalf("session with an active device: %+v", s)
	}
	e.expect(http.StatusNoContent, "DELETE", "/v3/devices/"+a.ID, a.Token, nil, nil)
	var er errorJSON
	for _, d := range []testDevice{a, b} {
		e.expect(http.StatusUnauthorized, "GET", "/v3/session", d.Token, nil, &er)
		if er.Error != "unauthorized" {
			t.Fatalf("token of a deleted session: %+v", er)
		}
	}
	if s := e.session(other); s.Revision != 0 {
		t.Fatalf("other session: %+v", s)
	}
}

// Every authenticated endpoint acts on the caller's session only; ids from
// another session behave as unknown.
func TestSessionsAreIsolated(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a1, a2 := e.pair("A1"), e.pair("A2")
	b1 := e.start("A1") // another session: the same name is free there

	t.Run("pairing codes and pair", func(t *testing.T) {
		var b2 testDevice
		e.expect(http.StatusCreated, "POST", "/v3/pair", "", map[string]string{"code": e.invite(b1), "name": "A2", "browser": "brave"}, &b2)
		if got := deviceNames(e.devices(b2)); got != "A1|A2" {
			t.Fatalf("session B devices %s", got)
		}
	})
	t.Run("devices", func(t *testing.T) {
		if got := deviceNames(e.devices(a1)); got != "A1|A2" {
			t.Fatalf("session A devices %s", got)
		}
		for _, d := range e.devices(b1) {
			if d.ID == a1.ID || d.ID == a2.ID {
				t.Fatalf("session B lists %+v", d)
			}
		}
	})
	t.Run("rename", func(t *testing.T) {
		var er errorJSON
		e.expect(http.StatusForbidden, "PATCH", "/v3/devices/"+a1.ID, b1.Token, map[string]string{"name": "Mine"}, &er)
		if er.Error != "forbidden" {
			t.Fatalf("rename across sessions: %+v", er)
		}
	})
	t.Run("revoke", func(t *testing.T) {
		var er errorJSON
		e.expect(http.StatusNotFound, "DELETE", "/v3/devices/"+a2.ID, b1.Token, nil, &er)
		if er.Error != "not_found" {
			t.Fatalf("revoke across sessions: %+v", er)
		}
		e.session(a2) // still active
	})

	// Both sessions have their own owner, generation, revision and log.
	e.acquire(a1, false)
	genA := e.acquire(a2, true)
	genB := e.acquire(b1, false)
	shared, onlyA := uid(), uid()
	sharedOp := openOp(shared, "https://shared.example/")

	t.Run("acquire", func(t *testing.T) {
		if genA != 2 || genB != 1 {
			t.Fatalf("generations A %d B %d", genA, genB)
		}
		if s := e.session(b1); s.Owner == nil || s.Owner.DeviceID != b1.ID {
			t.Fatalf("session B owner %+v", s.Owner)
		}
	})
	t.Run("operations", func(t *testing.T) {
		ra := e.ops(a2, genA, 0, sharedOp, openOp(onlyA, "https://a-only.example/"))
		rb := e.ops(b1, genB, 0, sharedOp) // same opId and entryId: new in session B
		if ra.Revision != 2 || rb.Revision != 1 || rb.Results[0].Replayed || rb.Results[0].Status != "applied" ||
			rb.Results[0].EntryID != shared || len(rb.CatchUp.Operations) != 0 {
			t.Fatalf("A %+v B %+v", ra, rb)
		}
	})
	t.Run("session", func(t *testing.T) {
		if s := e.session(b1); s.Revision != 1 || len(s.Entries) != 1 || s.Entries[0].ID != shared {
			t.Fatalf("session B %+v", s)
		}
		if got := e.urls(a1); !slices.Equal(got, []string{"https://a-only.example/", "https://shared.example/"}) {
			t.Fatalf("session A urls %v", got)
		}
	})
	t.Run("changes", func(t *testing.T) {
		var ch struct {
			Revision   int64      `json:"revision"`
			Owner      *ownerJSON `json:"owner"`
			Operations []loggedOp `json:"operations"`
		}
		e.expect(http.StatusOK, "GET", "/v3/session/changes?since=0", b1.Token, nil, &ch)
		if ch.Revision != 1 || ch.Owner.DeviceID != b1.ID || len(ch.Operations) != 1 || ch.Operations[0].DeviceID != b1.ID {
			t.Fatalf("session B changes %+v", ch)
		}
		var er errorJSON
		e.expect(http.StatusGone, "GET", "/v3/session/changes?since=2", b1.Token, nil, &er)
	})
	t.Run("heartbeat and release", func(t *testing.T) {
		var er errorJSON
		e.expect(http.StatusConflict, "POST", "/v3/session/heartbeat", b1.Token, map[string]int64{"generation": genA}, &er)
		if er.Error != "stale_owner" || er.Owner == nil || er.Owner.DeviceID != b1.ID {
			t.Fatalf("heartbeat with the other session's generation: %+v", er)
		}
		e.expect(http.StatusNoContent, "POST", "/v3/session/release", a2.Token, map[string]int64{"generation": genA}, nil)
		if s := e.session(b1); s.Owner == nil || s.Owner.DeviceID != b1.ID {
			t.Fatalf("release in A changed B's owner: %+v", s.Owner)
		}
		e.expect(http.StatusNoContent, "POST", "/v3/session/heartbeat", b1.Token, map[string]int64{"generation": genB}, nil)
	})
	t.Run("snapshots and restore", func(t *testing.T) {
		gen := e.acquire(a1, false)
		e.ops(a1, gen, 2, closeOp(onlyA)) // snapshot 1 in session A
		var snaps struct {
			Snapshots []json.RawMessage `json:"snapshots"`
		}
		e.expect(http.StatusOK, "GET", "/v3/snapshots", b1.Token, nil, &snaps)
		if len(snaps.Snapshots) != 0 {
			t.Fatalf("session B snapshots %s", snaps.Snapshots)
		}
		var er errorJSON
		e.expect(http.StatusNotFound, "POST", "/v3/snapshots/1/restore", b1.Token, map[string]int64{"generation": genB}, &er)
		if er.Error != "not_found" {
			t.Fatalf("restore across sessions: %+v", er)
		}
		e.expect(http.StatusOK, "POST", "/v3/snapshots/1/restore", a1.Token, map[string]int64{"generation": gen}, nil)
	})
	t.Run("merge", func(t *testing.T) {
		r := e.merge(b1, at(1, closeOp(onlyA)), at(1, navOp(onlyA, "https://x.example/")))
		if r.Revision != 1 || r.Results[0].Status != "ignored" || r.Results[1].Status != "ignored" {
			t.Fatalf("merge on another session's entry: %+v", r)
		}
		if got := e.urls(a1); len(got) != 2 {
			t.Fatalf("session A urls %v", got)
		}
	})
}

// deviceNames lists the device names, sorted.
func deviceNames(ds []deviceResp) string {
	names := make([]string, len(ds))
	for i, d := range ds {
		names[i] = d.Name
	}
	slices.Sort(names)
	return strings.Join(names, "|")
}

// post sends an unauthenticated POST with the given headers and returns the
// status, Retry-After and error code.
func (e *env) post(path string, headers map[string]string, body any) (int, string, string) {
	e.t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		e.t.Fatal(err)
	}
	req, err := http.NewRequest("POST", e.srv.URL+path, bytes.NewReader(data))
	if err != nil {
		e.t.Fatal(err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := e.srv.Client().Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	var er errorJSON
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		e.t.Fatal(err)
	}
	_ = json.Unmarshal(raw, &er)
	return resp.StatusCode, resp.Header.Get("Retry-After"), er.Error
}

func TestRateLimit(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	from := func(xff string) map[string]string { return map[string]string{"X-Forwarded-For": xff} }
	badPair := map[string]string{"code": "AAAAAAAA", "name": "A", "browser": "brave"}
	badSession := map[string]string{"keyCheck": "x", "name": "A", "browser": "brave"}

	// Both endpoints share the budget, and every request counts, failed ones too.
	for i := range 10 {
		path, body := "/v3/pair", any(badPair)
		if i%2 == 0 {
			path, body = "/v3/sessions", badSession
		}
		if st, _, _ := e.post(path, from("203.0.113.7"), body); st == http.StatusTooManyRequests {
			t.Fatalf("request %d limited", i+1)
		}
	}
	for _, path := range []string{"/v3/sessions", "/v3/pair"} {
		st, retry, code := e.post(path, from("203.0.113.7"), badPair)
		if st != http.StatusTooManyRequests || code != "rate_limited" || retry != "600" {
			t.Fatalf("%s over budget: %d %q %q", path, st, retry, code)
		}
	}
	// The last X-Forwarded-For entry (appended by the proxy) is the client:
	// a forged first entry does not help, another client is unaffected.
	if st, _, _ := e.post("/v3/pair", from("198.51.100.9, 203.0.113.7"), badPair); st != http.StatusTooManyRequests {
		t.Fatalf("forged first entry: %d", st)
	}
	if st, _, _ := e.post("/v3/pair", from("203.0.113.7, 203.0.113.8"), badPair); st != http.StatusBadRequest {
		t.Fatalf("other client: %d", st)
	}
	// Authenticated endpoints are not limited.
	a := e.start("A")
	for range 12 {
		req, _ := http.NewRequest("GET", e.srv.URL+"/v3/session", nil)
		req.Header.Set("Authorization", "Bearer "+a.Token)
		req.Header.Set("X-Forwarded-For", "203.0.113.7")
		resp, err := e.srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("authenticated request: %d", resp.StatusCode)
		}
	}

	e.clock.Advance(4*time.Minute + 30*time.Second)
	if _, retry, _ := e.post("/v3/pair", from("203.0.113.7"), badPair); retry != "330" {
		t.Fatalf("Retry-After after 4m30s: %q", retry)
	}
	e.clock.Advance(5*time.Minute + 30*time.Second)
	if st, _, _ := e.post("/v3/pair", from("203.0.113.7"), badPair); st != http.StatusBadRequest {
		t.Fatalf("next window: %d", st)
	}
}

func TestRateLimitClientIPHeader(t *testing.T) {
	t.Parallel()
	e := newEnv(t, func(c *config.Config) { c.ClientIPHeader = "CF-Connecting-IP" })
	badPair := map[string]string{"code": "AAAAAAAA", "name": "A", "browser": "brave"}
	for i := range 11 {
		// The proxy chain varies; the configured header names the client.
		st, _, _ := e.post("/v3/pair", map[string]string{
			"CF-Connecting-IP": "203.0.113.7", "X-Forwarded-For": "10.0.0." + string(rune('0'+i%10)),
		}, badPair)
		if want := http.StatusBadRequest; i == 10 {
			if st != http.StatusTooManyRequests {
				t.Fatalf("11th request: %d", st)
			}
		} else if st != want {
			t.Fatalf("request %d: %d", i+1, st)
		}
	}
	// Without the header the X-Forwarded-For rule applies.
	if st, _, _ := e.post("/v3/pair", map[string]string{"X-Forwarded-For": "203.0.113.8"}, badPair); st != http.StatusBadRequest {
		t.Fatalf("fallback to X-Forwarded-For: %d", st)
	}
}

func TestClientKey(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, header string
		headers      map[string][]string
		want         string
	}{
		{"connection", "", nil, "192.0.2.1"},
		{"xff single", "", map[string][]string{"X-Forwarded-For": {"203.0.113.7"}}, "203.0.113.7"},
		{"xff last entry", "", map[string][]string{"X-Forwarded-For": {"198.51.100.1, 203.0.113.7 "}}, "203.0.113.7"},
		{"xff last header", "", map[string][]string{"X-Forwarded-For": {"198.51.100.1", "203.0.113.7"}}, "203.0.113.7"},
		{"xff with port", "", map[string][]string{"X-Forwarded-For": {"203.0.113.7:4711"}}, "203.0.113.7"},
		{"xff empty", "", map[string][]string{"X-Forwarded-For": {" "}}, "192.0.2.1"},
		{"xff invalid", "", map[string][]string{"X-Forwarded-For": {"unknown"}}, "192.0.2.1"},
		{"header", "CF-Connecting-IP", map[string][]string{"Cf-Connecting-Ip": {"203.0.113.9"}, "X-Forwarded-For": {"203.0.113.7"}}, "203.0.113.9"},
		{"header first entry", "X-Real-Client", map[string][]string{"X-Real-Client": {"203.0.113.9, 10.0.0.1"}}, "203.0.113.9"},
		{"header missing", "CF-Connecting-IP", map[string][]string{"X-Forwarded-For": {"203.0.113.7"}}, "203.0.113.7"},
		{"header invalid", "CF-Connecting-IP", map[string][]string{"Cf-Connecting-Ip": {strings.Repeat("x", 1<<16)}}, "192.0.2.1"},
		{"header ignored when unset", "", map[string][]string{"Cf-Connecting-Ip": {"203.0.113.9"}}, "192.0.2.1"},
		{"ipv6 /64", "", map[string][]string{"X-Forwarded-For": {"2001:db8:1:2:aaaa:bbbb:cccc:dddd"}}, "2001:db8:1:2::"},
		{"ipv6 zone and port", "", map[string][]string{"X-Forwarded-For": {"[fe80::1%eth0]:443"}}, "fe80::"},
		{"ipv4-mapped", "", map[string][]string{"X-Forwarded-For": {"::ffff:203.0.113.7"}}, "203.0.113.7"},
	} {
		r, _ := http.NewRequest("POST", "/v3/pair", nil)
		r.RemoteAddr = "192.0.2.1:4242"
		for k, vs := range tc.headers {
			for _, v := range vs {
				r.Header.Add(k, v)
			}
		}
		if got := clientKey(r, tc.header); got != tc.want {
			t.Errorf("%s: %q, want %q", tc.name, got, tc.want)
		}
	}
}

// Two addresses in one IPv6 /64 share a budget; another /64 has its own.
func TestRateLimitIPv6Prefix(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	badPair := map[string]string{"code": "AAAAAAAA", "name": "A", "browser": "brave"}
	for i := range 10 {
		xff := fmt.Sprintf("2001:db8:0:1::%x", i+1)
		if st, _, _ := e.post("/v3/pair", map[string]string{"X-Forwarded-For": xff}, badPair); st != http.StatusBadRequest {
			t.Fatalf("request %d: %d", i+1, st)
		}
	}
	if st, _, _ := e.post("/v3/pair", map[string]string{"X-Forwarded-For": "2001:db8:0:1:ffff::1"}, badPair); st != http.StatusTooManyRequests {
		t.Fatalf("same /64: %d", st)
	}
	if st, _, _ := e.post("/v3/pair", map[string]string{"X-Forwarded-For": "2001:db8:0:2::1"}, badPair); st != http.StatusBadRequest {
		t.Fatalf("other /64: %d", st)
	}
}

func TestLimiterSweepsExpiredWindows(t *testing.T) {
	t.Parallel()
	l := newLimiter()
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, ip := range []string{"a", "b", "c"} {
		l.allow(ip, t0)
	}
	l.allow("d", t0.Add(5*time.Minute))
	l.allow("e", t0.Add(rateWindow))
	if len(l.windows) != 2 { // a, b and c expired; d is live
		t.Fatalf("windows after sweep: %v", l.windows)
	}
}

// The limiter tracks at most rateClients keys: when full, new keys wait
// until expired windows can be swept; known keys keep their budget.
func TestLimiterCap(t *testing.T) {
	t.Parallel()
	l := newLimiter()
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := range rateClients {
		l.allow(strconv.Itoa(i), t0.Add(time.Duration(i)*time.Millisecond))
	}
	now := t0.Add(time.Minute)
	if ok, wait := l.allow("new", now); ok || wait != rateWindow {
		t.Fatalf("new key while full: %v %v", ok, wait)
	}
	if ok, _ := l.allow("0", now); !ok {
		t.Fatal("known key refused while full")
	}
	if len(l.windows) != rateClients {
		t.Fatalf("windows %d", len(l.windows))
	}
	// Once the oldest windows expire, a new key sweeps them and fits.
	if ok, _ := l.allow("new", t0.Add(rateWindow+time.Millisecond)); !ok || len(l.windows) > rateClients {
		t.Fatalf("new key after expiry: %v, %d windows", ok, len(l.windows))
	}
}

func TestRootPage(t *testing.T) {
	t.Parallel()
	e := newEnv(t, func(c *config.Config) { c.AllowInsecure = false })
	req, _ := http.NewRequest("GET", e.srv.URL+"/", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	resp, err := e.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	page := string(body)
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html") ||
		!strings.Contains(resp.Header.Get("Content-Security-Policy"), "default-src 'none'") {
		t.Fatalf("root: %d %v", resp.StatusCode, resp.Header)
	}
	for _, want := range []string{
		"https://github.com/KaanEmec/cross-tab-sync#install",
		"https://github.com/KaanEmec/cross-tab-sync/blob/main/docs/PRIVACY.md",
		"Paste it into the extension",
	} {
		if !strings.Contains(page, want) {
			t.Errorf("root page lacks %q", want)
		}
	}
	if strings.Contains(strings.ToLower(page), "<script") {
		t.Fatal("root page has a script")
	}
	// Only the exact root: other paths and methods stay 404.
	var er errorJSON
	for _, r := range []struct{ method, path string }{{"GET", "/index.html"}, {"GET", "/x/"}, {"POST", "/"}} {
		e2 := newEnv(t, nil)
		if st := e2.call(r.method, r.path, "", nil, &er); st != http.StatusNotFound || er.Error != "not_found" {
			t.Errorf("%s %s: %d %+v", r.method, r.path, st, er)
		}
	}
}
