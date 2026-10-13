package api

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/kaanemec/cross-tab-sync/server/internal/session"
)

type mergeResp struct {
	Revision int64    `json:"revision"`
	Results  []result `json:"results"`
}

func (e *env) merge(d testDevice, ops ...op) mergeResp {
	e.t.Helper()
	if ops == nil {
		ops = []op{}
	}
	var r mergeResp
	e.expect(http.StatusOK, "POST", "/v1/session/merge", d.Token, map[string]any{"operations": ops}, &r)
	return r
}

// at sets an operation's baseRevision.
func at(base int64, o op) op {
	o["baseRevision"] = base
	return o
}

func navOp(entryID, url string) op {
	return op{"opId": uid(), "type": "navigate", "entryId": entryID, "url": url}
}

func closeOp(entryID string) op { return op{"opId": uid(), "type": "close", "entryId": entryID} }

func (e *env) urls(d testDevice) []string {
	e.t.Helper()
	var out []string
	for _, en := range e.session(d).Entries {
		out = append(out, en.URL)
	}
	slices.Sort(out)
	return out
}

func TestMergeForkedNavigateKeepsBothURLs(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a, b := e.pair("A"), e.pair("B")
	gen := e.acquire(a, false)
	e1 := uid()
	e.ops(a, gen, 0, openOp(e1, "https://a.example/"))

	// B, offline at revision 1, navigates e1; meanwhile the owner navigates it too.
	nav := at(1, navOp(e1, "https://b.example/"))
	e.ops(a, gen, 1, navOp(e1, "https://c.example/"))
	owner := e.session(a).Owner

	r := e.merge(b, nav)
	forked := session.ForkedEntryID(nav["opId"].(string))
	if r.Revision != 3 || len(r.Results) != 1 || r.Results[0].Status != "forked" || r.Results[0].EntryID != forked {
		t.Fatalf("merge: %+v", r)
	}
	if got := e.urls(a); !slices.Equal(got, []string{"https://b.example/", "https://c.example/"}) {
		t.Fatalf("both destinations must survive: %v", got)
	}
	if s := e.session(a); *s.Owner != *owner {
		t.Fatalf("merge changed ownership: %+v -> %+v", owner, s.Owner)
	}

	// Followers see the fork as an open of the new entry.
	var ch struct {
		Operations []loggedOp `json:"operations"`
	}
	e.expect(http.StatusOK, "GET", "/v1/session/changes?since=2", a.Token, nil, &ch)
	if len(ch.Operations) != 1 {
		t.Fatalf("changes: %+v", ch)
	}
	lo := ch.Operations[0]
	if lo.Seq != 3 || lo.DeviceID != b.ID || lo.Op["type"] != "open" || lo.Op["entryId"] != forked ||
		lo.Op["url"] != "https://b.example/" || lo.Result.Status != "forked" || lo.Result.EntryID != forked {
		t.Fatalf("logged fork: %+v", lo)
	}
	// The owner keeps publishing with its generation.
	if r := e.ops(a, gen, 3); r.Revision != 3 {
		t.Fatalf("owner after merge: %+v", r)
	}
}

func TestMergeFromNonOwnerWhileOwned(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a, b := e.pair("A"), e.pair("B")
	gen := e.acquire(a, false)
	e1, e2, e3 := uid(), uid(), uid()
	e.ops(a, gen, 0, openOp(e1, "https://a.example/"), openOp(e2, "https://b.example/"), openOp(e3, "https://c.example/"))
	e.ops(a, gen, 3, navOp(e1, "https://a2.example/"))                                   // 4: URL change
	e.ops(a, gen, 4, op{"opId": uid(), "type": "update", "entryId": e2, "pinned": true}) // 5: metadata only
	owner := e.session(a).Owner

	if r := e.merge(b); r.Revision != 5 || len(r.Results) != 0 {
		t.Fatalf("empty merge: %+v", r)
	}
	d := uid()
	r := e.merge(b,
		at(3, closeOp(e1)), // navigated since 3: ignored
		at(3, op{"opId": uid(), "type": "update", "entryId": e1, "pinned": true}), // ignored
		at(3, closeOp(e2)), // metadata change does not block: applied
		at(3, op{"opId": uid(), "type": "update", "entryId": e3, "pinned": true}), // applied
		at(3, openOp(uid(), "https://c.example/")),                                // coalesced on URL
		at(0, openOp(d, "https://d.example/")),                                    // applied
	)
	want := []struct{ status, entryID string }{
		{"ignored", ""}, {"ignored", ""}, {"applied", e2}, {"applied", e3}, {"coalesced", e3}, {"applied", d},
	}
	for i, w := range want {
		if got := r.Results[i]; got.Status != w.status || got.EntryID != w.entryID || got.Replayed {
			t.Fatalf("result %d = %+v, want %+v", i, got, w)
		}
	}
	if r.Revision != 9 {
		t.Fatalf("revision %d, want 9", r.Revision)
	}
	s := e.session(a)
	if *s.Owner != *owner {
		t.Fatalf("merge changed ownership: %+v -> %+v", owner, s.Owner)
	}
	if got := e.urls(a); !slices.Equal(got, []string{"https://a2.example/", "https://c.example/", "https://d.example/"}) {
		t.Fatalf("urls %v", got)
	}

	// A revoked device cannot merge.
	e.expect(http.StatusNoContent, "DELETE", "/v1/devices/"+b.ID, a.Token, nil, nil)
	var er errorJSON
	e.expect(http.StatusUnauthorized, "POST", "/v1/session/merge", b.Token, map[string]any{"operations": []op{}}, &er)
	if er.Error != "device_revoked" {
		t.Fatalf("%+v", er)
	}
}

func TestMergeReplay(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a, b := e.pair("A"), e.pair("B")
	gen := e.acquire(a, false)
	e1, e2 := uid(), uid()
	e.ops(a, gen, 0, openOp(e1, "https://a.example/"), openOp(e2, "https://b.example/"))
	e.ops(a, gen, 2, navOp(e1, "https://a2.example/")) // 3

	batch := []op{at(2, closeOp(e2)), at(2, navOp(e1, "https://x.example/")), at(2, openOp(uid(), "https://y.example/"))}
	first := e.merge(b, batch...)
	second := e.merge(b, batch...)
	if first.Revision != 6 || second.Revision != first.Revision {
		t.Fatalf("revisions %d then %d", first.Revision, second.Revision)
	}
	for i, r := range second.Results {
		f := first.Results[i]
		if f.Replayed || !r.Replayed || r.OpID != f.OpID || r.Status != f.Status || r.EntryID != f.EntryID {
			t.Fatalf("result %d: first %+v, replay %+v", i, f, r)
		}
	}
	if first.Results[1].Status != "forked" {
		t.Fatalf("navigate: %+v", first.Results[1])
	}

	// One recovery snapshot, taken before the first (close/navigate) batch only.
	var snaps struct {
		Snapshots []struct {
			Revision int64  `json:"revision"`
			DeviceID string `json:"deviceId"`
			Reason   string `json:"reason"`
		} `json:"snapshots"`
	}
	e.expect(http.StatusOK, "GET", "/v1/snapshots", b.Token, nil, &snaps)
	if len(snaps.Snapshots) != 2 { // the owner's navigate + the merge
		t.Fatalf("snapshots: %+v", snaps)
	}
	if s := snaps.Snapshots[0]; s.Revision != 3 || s.DeviceID != b.ID || s.Reason != "operations" {
		t.Fatalf("merge snapshot: %+v", s)
	}
}

func TestMergeValidation(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	b := e.pair("B")
	good := func() op { return at(0, openOp(uid(), "https://a.example/")) }
	tooMany := make([]op, session.MaxBatchOps+1)
	for i := range tooMany {
		tooMany[i] = op{"opId": uid(), "type": "close", "entryId": uid(), "baseRevision": 0}
	}
	tests := []struct {
		name   string
		body   any
		status int
		code   string
	}{
		{"missing baseRevision", map[string]any{"operations": []op{good(), openOp(uid(), "https://b.example/")}}, http.StatusBadRequest, "invalid_request"},
		{"negative baseRevision", map[string]any{"operations": []op{good(), at(-1, closeOp(uid()))}}, http.StatusBadRequest, "invalid_request"},
		{"bad url", map[string]any{"operations": []op{good(), at(0, openOp(uid(), "file:///etc/passwd"))}}, http.StatusBadRequest, "invalid_request"},
		{"not an object", []byte(`[1]`), http.StatusBadRequest, "invalid_request"},
		{"too many", map[string]any{"operations": tooMany}, http.StatusRequestEntityTooLarge, "payload_too_large"},
		{"body too large", []byte(`{"operations":[` + strings.Repeat(" ", 64<<10) + `]}`), http.StatusRequestEntityTooLarge, "payload_too_large"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var er errorJSON
			if st := e.call("POST", "/v1/session/merge", b.Token, tt.body, &er); st != tt.status || er.Error != tt.code {
				t.Fatalf("status %d %+v, want %d %s", st, er, tt.status, tt.code)
			}
		})
	}
	if s := e.session(b); s.Revision != 0 || len(s.Entries) != 0 {
		t.Fatalf("rejected batches changed state: %+v", s)
	}
}

func TestHistoryRetentionThresholds(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil) // CTS_HISTORY_RETENTION 720h
	a, b := e.pair("A"), e.pair("B")
	gen := e.acquire(a, false)
	e1, e2, e3 := uid(), uid(), uid()
	open1 := openOp(e1, "https://a.example/")
	e.ops(a, gen, 0, open1, openOp(e2, "https://b.example/"), closeOp(e2)) // 1..3
	if s := e.session(a); s.Revision != 3 || minRevision(t, e, a) != 1 {
		t.Fatalf("before pruning: %+v", s)
	}

	e.clock.Advance(31 * 24 * time.Hour)
	e.ops(a, gen, 3, openOp(e3, "https://c.example/")) // 4
	res, err := e.st.Prune(context.Background(), e.clock.Now(), 720*time.Hour)
	if err != nil || res.MinRevision != 4 || res.Tombstones != 1 {
		t.Fatalf("prune: %+v %v", res, err)
	}
	if got := minRevision(t, e, a); got != 4 {
		t.Fatalf("session minRevision %d", got)
	}
	if got := e.urls(a); !slices.Equal(got, []string{"https://a.example/", "https://c.example/"}) {
		t.Fatalf("open entries must survive pruning: %v", got)
	}

	// changes: since >= minRevision-1 is served, older is 410.
	var er errorJSON
	e.expect(http.StatusGone, "GET", "/v1/session/changes?since=2", a.Token, nil, &er)
	if er.Error != "history_expired" {
		t.Fatalf("%+v", er)
	}
	var ch struct {
		MinRevision int64      `json:"minRevision"`
		Operations  []loggedOp `json:"operations"`
	}
	e.expect(http.StatusOK, "GET", "/v1/session/changes?since=3", a.Token, nil, &ch)
	if ch.MinRevision != 4 || len(ch.Operations) != 1 || ch.Operations[0].Seq != 4 {
		t.Fatalf("changes since 3: %+v", ch)
	}

	// operations: fullResync and no catchUp below the threshold.
	for _, tt := range []struct {
		base       int64
		fullResync bool
	}{{2, true}, {3, false}} {
		var raw map[string]json.RawMessage
		e.expect(http.StatusOK, "POST", "/v1/session/operations", a.Token,
			map[string]any{"generation": gen, "baseRevision": tt.base, "operations": []op{}}, &raw)
		_, hasCatchUp := raw["catchUp"]
		if got := string(raw["fullResync"]) == "true"; got != tt.fullResync || hasCatchUp == tt.fullResync {
			t.Fatalf("base %d: %s", tt.base, mapKeys(raw))
		}
	}

	// A pruned opId is a new operation: no replay flag, coalesces on the open entry.
	if r := e.ops(a, gen, 4, open1); r.Revision != 5 || r.Results[0].Replayed || r.Results[0].Status != "coalesced" {
		t.Fatalf("pruned opId resent: %+v", r)
	}

	// merge: a base outside the retained history is stale even though e1's
	// URL has not changed since revision 1.
	if r := e.merge(b, at(2, closeOp(e1))); r.Results[0].Status != "ignored" {
		t.Fatalf("expired close: %+v", r)
	}
	if r := e.merge(b, at(3, closeOp(e1))); r.Results[0].Status != "applied" {
		t.Fatalf("retained close: %+v", r)
	}
}

func minRevision(t *testing.T, e *env, d testDevice) int64 {
	t.Helper()
	var s struct {
		MinRevision *int64 `json:"minRevision"`
	}
	e.expect(http.StatusOK, "GET", "/v1/session", d.Token, nil, &s)
	if s.MinRevision == nil {
		t.Fatal("GET session has no minRevision")
	}
	return *s.MinRevision
}

func mapKeys(m map[string]json.RawMessage) string {
	var ks []string
	for k, v := range m {
		ks = append(ks, k+"="+string(v))
	}
	slices.Sort(ks)
	return strings.Join(ks, " ")
}
