package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kaanemec/cross-tab-sync/server/internal/config"
	"github.com/kaanemec/cross-tab-sync/server/internal/store"
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// syncBuffer is a goroutine-safe log sink.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type env struct {
	t     *testing.T
	srv   *httptest.Server
	st    *store.Store
	clock *clock
	logs  *syncBuffer
}

func newEnv(t *testing.T, mutate func(*config.Config)) *env {
	t.Helper()
	cfg := config.Default()
	cfg.AllowInsecure = true
	cfg.DBPath = filepath.Join(t.TempDir(), "cts.db")
	if mutate != nil {
		mutate(&cfg)
	}
	st, err := store.Open(context.Background(), cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	clk := &clock{t: time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)}
	logs := &syncBuffer{}
	srv := httptest.NewServer(New(st, cfg, slog.New(slog.NewJSONHandler(logs, nil)), clk.Now))
	t.Cleanup(func() {
		srv.Close()
		_ = st.Close()
	})
	return &env{t: t, srv: srv, st: st, clock: clk, logs: logs}
}

// call sends a request and decodes a JSON response into out (if non-nil).
func (e *env) call(method, path, token string, body, out any) int {
	e.t.Helper()
	var rd io.Reader
	switch b := body.(type) {
	case nil:
	case []byte:
		rd = bytes.NewReader(b)
	default:
		data, err := json.Marshal(b)
		if err != nil {
			e.t.Fatal(err)
		}
		rd = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, e.srv.URL+path, rd)
	if err != nil {
		e.t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := e.srv.Client().Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		e.t.Fatal(err)
	}
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			e.t.Fatalf("%s %s: decoding %q: %v", method, path, data, err)
		}
	}
	return resp.StatusCode
}

// expect is call plus a status assertion.
func (e *env) expect(want int, method, path, token string, body, out any) {
	e.t.Helper()
	if got := e.call(method, path, token, body, out); got != want {
		e.t.Fatalf("%s %s: status %d, want %d", method, path, got, want)
	}
}

type testDevice struct {
	ID    string `json:"deviceId"`
	Token string `json:"token"`
}

func (e *env) pair(name string) testDevice {
	e.t.Helper()
	code, _, err := e.st.CreatePairingCode(context.Background(), "", e.clock.Now())
	if err != nil {
		e.t.Fatal(err)
	}
	var d testDevice
	e.expect(http.StatusCreated, "POST", "/v1/pair", "", map[string]string{"code": code, "name": name, "browser": "brave"}, &d)
	return d
}

type ownerJSON struct {
	DeviceID   string    `json:"deviceId"`
	Name       string    `json:"name"`
	Generation int64     `json:"generation"`
	LastSeenAt time.Time `json:"lastSeenAt"`
}

type errorJSON struct {
	Error   string     `json:"error"`
	Message string     `json:"message"`
	Owner   *ownerJSON `json:"owner"`
}

type entry struct {
	ID              string `json:"id"`
	URL             string `json:"url"`
	Pinned          bool   `json:"pinned"`
	Position        int64  `json:"position"`
	UpdatedRevision int64  `json:"updatedRevision"`
}

type sessionResp struct {
	Revision int64      `json:"revision"`
	Owner    *ownerJSON `json:"owner"`
	Entries  []entry    `json:"entries"`
}

type acquireResp struct {
	Generation int64       `json:"generation"`
	Session    sessionResp `json:"session"`
}

type result struct {
	OpID     string `json:"opId"`
	Status   string `json:"status"`
	EntryID  string `json:"entryId"`
	Replayed bool   `json:"replayed"`
}

type loggedOp struct {
	Seq      int64          `json:"seq"`
	DeviceID string         `json:"deviceId"`
	Op       map[string]any `json:"op"`
	Result   result         `json:"result"`
}

type opsResp struct {
	Revision int64    `json:"revision"`
	Results  []result `json:"results"`
	CatchUp  struct {
		Operations []loggedOp `json:"operations"`
	} `json:"catchUp"`
}

type op = map[string]any

var idSeq atomic.Int64

// uid returns a fresh lowercase UUID-shaped id.
func uid() string {
	return fmt.Sprintf("00000000-0000-4000-8000-%012x", idSeq.Add(1))
}

func openOp(entryID, url string) op {
	return op{"opId": uid(), "type": "open", "entryId": entryID, "url": url}
}

func (e *env) acquire(d testDevice, force bool) int64 {
	e.t.Helper()
	var r acquireResp
	e.expect(http.StatusOK, "POST", "/v1/session/acquire", d.Token, map[string]bool{"force": force}, &r)
	return r.Generation
}

func (e *env) ops(d testDevice, gen, base int64, ops ...op) opsResp {
	e.t.Helper()
	var r opsResp
	e.expect(http.StatusOK, "POST", "/v1/session/operations", d.Token,
		map[string]any{"generation": gen, "baseRevision": base, "operations": ops}, &r)
	return r
}

func (e *env) session(d testDevice) sessionResp {
	e.t.Helper()
	var s sessionResp
	e.expect(http.StatusOK, "GET", "/v1/session", d.Token, nil, &s)
	return s
}
