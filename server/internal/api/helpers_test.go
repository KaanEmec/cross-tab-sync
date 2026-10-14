package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
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
	e.expect(http.StatusCreated, "POST", "/v2/pair", "", map[string]string{"code": code, "name": name, "browser": "brave"}, &d)
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
	URLKey          string `json:"urlKey"`
	URLEnc          string `json:"urlEnc"`
	Pinned          bool   `json:"pinned"`
	Position        int64  `json:"position"`
	UpdatedRevision int64  `json:"updatedRevision"`
}

// URL is the plaintext behind the test stand-in ciphertext (see sealed).
func (en entry) URL() string { return unseal(en.URLEnc) }

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

// sealed derives deterministic stand-ins for a client's urlKey and urlEnc
// (the server only checks their shape): key is base64url(SHA-256(url)), enc
// the URL zero-padded to a multiple of 64 bytes, base64url-encoded.
func sealed(url string) (key, enc string) {
	sum := sha256.Sum256([]byte(url))
	padded := make([]byte, (len(url)+63)/64*64)
	copy(padded, url)
	return base64.RawURLEncoding.EncodeToString(sum[:]), base64.RawURLEncoding.EncodeToString(padded)
}

func urlKey(url string) string { k, _ := sealed(url); return k }

// unseal reverses sealed's enc; "" for anything else.
func unseal(enc any) string {
	s, _ := enc.(string)
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return ""
	}
	return strings.TrimRight(string(b), "\x00")
}

func urlOp(typ, entryID, url string) op {
	k, e := sealed(url)
	return op{"opId": uid(), "type": typ, "entryId": entryID, "urlKey": k, "urlEnc": e}
}

func openOp(entryID, url string) op { return urlOp("open", entryID, url) }

func (e *env) acquire(d testDevice, force bool) int64 {
	e.t.Helper()
	var r acquireResp
	e.expect(http.StatusOK, "POST", "/v2/session/acquire", d.Token, map[string]bool{"force": force}, &r)
	return r.Generation
}

func (e *env) ops(d testDevice, gen, base int64, ops ...op) opsResp {
	e.t.Helper()
	var r opsResp
	e.expect(http.StatusOK, "POST", "/v2/session/operations", d.Token,
		map[string]any{"generation": gen, "baseRevision": base, "operations": ops}, &r)
	return r
}

func (e *env) session(d testDevice) sessionResp {
	e.t.Helper()
	var s sessionResp
	e.expect(http.StatusOK, "GET", "/v2/session", d.Token, nil, &s)
	return s
}
