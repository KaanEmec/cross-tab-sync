package api

import (
	"bytes"
	_ "embed" // root page
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/kaanemec/cross-tab-sync/server/internal/session"
	"github.com/kaanemec/cross-tab-sync/server/internal/store"
)

type entryJSON struct {
	ID              string `json:"id"`
	URLKey          string `json:"urlKey"`
	URLEnc          string `json:"urlEnc"`
	Pinned          bool   `json:"pinned"`
	Position        int64  `json:"position"`
	UpdatedRevision int64  `json:"updatedRevision"`
}

type sessionJSON struct {
	Revision    int64        `json:"revision"`
	MinRevision int64        `json:"minRevision"`
	KeyCheck    string       `json:"keyCheck"`
	Owner       *store.Owner `json:"owner"`
	Entries     []entryJSON  `json:"entries"`
}

func toSessionJSON(s store.Session) sessionJSON {
	out := sessionJSON{Revision: s.Revision, MinRevision: s.MinRevision, KeyCheck: s.KeyCheck, Owner: s.Owner,
		Entries: make([]entryJSON, len(s.Entries))}
	for i, e := range s.Entries {
		out.Entries[i] = entryJSON{ID: e.ID, URLKey: e.URLKey, URLEnc: e.URLEnc, Pinned: e.Pinned, Position: e.Position, UpdatedRevision: e.UpdatedRevision}
	}
	return out
}

func results(rs []session.Result) []session.Result {
	if rs == nil {
		return []session.Result{}
	}
	return rs
}

//go:embed root.html
var rootPage []byte

// root serves a static page without script: invite links carry the key in
// their fragment, which a script on this origin could read.
func (s *Server) root(w http.ResponseWriter, _ *http.Request) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	h.Set("Referrer-Policy", "no-referrer")
	_, _ = w.Write(rootPage) // the client may have gone away; nothing to do
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	if err := s.store.Ping(r.Context()); err != nil {
		s.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// validLabel accepts 1..max runes of printable text after trimming.
func validLabel(s string, maxRunes int) (string, bool) {
	s = strings.TrimSpace(s)
	if s == "" || !utf8.ValidString(s) || utf8.RuneCountInString(s) > maxRunes {
		return "", false
	}
	for _, r := range s {
		if !unicode.IsPrint(r) {
			return "", false
		}
	}
	return s, true
}

// deviceLabels validates the name and browser of a new device, writing
// 400 invalid_request and returning false when either is invalid.
func deviceLabels(w http.ResponseWriter, name, browser string) (string, string, bool) {
	name, ok := validLabel(name, session.MaxNameLength)
	if !ok {
		invalid(w, fmt.Sprintf("name must be 1..%d printable characters", session.MaxNameLength))
		return "", "", false
	}
	browser, ok = validLabel(browser, 32)
	if !ok {
		invalid(w, "browser must be 1..32 printable characters")
		return "", "", false
	}
	return name, browser, true
}

// paired answers a new device's credentials and records it for the access log.
func paired(w http.ResponseWriter, r *http.Request, dev store.Device, token string) {
	if info, ok := r.Context().Value(infoKey).(*reqInfo); ok {
		info.deviceID = dev.ID
	}
	writeJSON(w, http.StatusCreated, map[string]string{"deviceId": dev.ID, "token": token, "name": dev.Name})
}

// createSession starts a session with the caller's key check and the caller
// as its first device.
func (s *Server) createSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		KeyCheck string `json:"keyCheck"`
		Name     string `json:"name"`
		Browser  string `json:"browser"`
	}
	if !decode(w, r, &req, false) {
		return
	}
	if !session.IsKey(req.KeyCheck) {
		invalid(w, fmt.Sprintf("keyCheck must be %d base64url characters", session.URLKeyLength))
		return
	}
	name, browser, ok := deviceLabels(w, req.Name, req.Browser)
	if !ok {
		return
	}
	dev, token, err := s.store.CreateSession(r.Context(), req.KeyCheck, name, browser, s.now(), s.cfg.MaxSessions)
	if errors.Is(err, store.ErrSessionsClosed) {
		writeError(w, http.StatusForbidden, "sessions_closed", "this server accepts no new sessions", nil)
		return
	}
	if err != nil {
		s.internal(w, r, err)
		return
	}
	paired(w, r, dev, token)
}

func (s *Server) pair(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code    string `json:"code"`
		Name    string `json:"name"`
		Browser string `json:"browser"`
	}
	if !decode(w, r, &req, false) {
		return
	}
	name, browser, ok := deviceLabels(w, req.Name, req.Browser)
	if !ok {
		return
	}
	dev, token, err := s.store.Pair(r.Context(), req.Code, name, browser, s.now(), s.cfg.MaxDevices)
	switch {
	case errors.Is(err, store.ErrInvalidCode):
		writeError(w, http.StatusBadRequest, "invalid_code", "pairing code is invalid, used or expired", nil)
	case errors.Is(err, store.ErrSessionFull):
		writeError(w, http.StatusForbidden, "session_full",
			fmt.Sprintf("the session already has %d devices; revoke one first", s.cfg.MaxDevices), nil)
	case err != nil:
		s.internal(w, r, err)
	default:
		paired(w, r, dev, token)
	}
}

func (s *Server) createPairingCode(w http.ResponseWriter, r *http.Request) {
	code, expires, err := s.store.CreatePairingCode(r.Context(), device(r).ID, s.now())
	if err != nil {
		s.storeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"code": code, "expiresAt": store.Timestamp{Time: expires}})
}

type deviceJSON struct {
	ID         string           `json:"id"`
	Name       string           `json:"name"`
	Browser    string           `json:"browser"`
	CreatedAt  store.Timestamp  `json:"createdAt"`
	LastSeenAt store.Timestamp  `json:"lastSeenAt"`
	IsSelf     bool             `json:"isSelf"`
	RevokedAt  *store.Timestamp `json:"revokedAt,omitempty"`
}

func toDeviceJSON(d store.Device, self string) deviceJSON {
	out := deviceJSON{ID: d.ID, Name: d.Name, Browser: d.Browser, CreatedAt: store.Timestamp{Time: d.CreatedAt},
		LastSeenAt: store.Timestamp{Time: d.LastSeenAt}, IsSelf: d.ID == self}
	if !d.RevokedAt.IsZero() {
		out.RevokedAt = &store.Timestamp{Time: d.RevokedAt}
	}
	return out
}

func (s *Server) listDevices(w http.ResponseWriter, r *http.Request) {
	ds, err := s.store.ListDevices(r.Context(), device(r).ID, s.now())
	if err != nil {
		s.storeError(w, r, err)
		return
	}
	self := device(r).ID
	out := make([]deviceJSON, len(ds))
	for i, d := range ds {
		out[i] = toDeviceJSON(d, self)
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": out})
}

// renameDevice renames the calling device; other devices are 403 forbidden.
func (s *Server) renameDevice(w http.ResponseWriter, r *http.Request) {
	self := device(r).ID
	if r.PathValue("id") != self {
		writeError(w, http.StatusForbidden, "forbidden", "a device can only rename itself", nil)
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &req, false) {
		return
	}
	name, ok := validLabel(req.Name, session.MaxNameLength)
	if !ok {
		invalid(w, fmt.Sprintf("name must be 1..%d printable characters", session.MaxNameLength))
		return
	}
	d, err := s.store.RenameDevice(r.Context(), self, name)
	if err != nil {
		s.storeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toDeviceJSON(d, self))
}

func (s *Server) revokeDevice(w http.ResponseWriter, r *http.Request) {
	if err := s.store.RevokeDevice(r.Context(), device(r).ID, r.PathValue("id"), s.now()); err != nil {
		s.storeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	sess, err := s.store.GetSession(r.Context(), device(r).ID)
	if err != nil {
		s.storeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toSessionJSON(sess))
}

func (s *Server) changes(w http.ResponseWriter, r *http.Request) {
	since, err := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	if err != nil {
		invalid(w, "since must be an integer revision")
		return
	}
	cs, err := s.store.Changes(r.Context(), device(r).ID, since)
	if err != nil {
		s.storeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"revision": cs.Revision, "minRevision": cs.MinRevision, "owner": cs.Owner, "operations": cs.Operations,
	})
}

func (s *Server) acquire(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Force bool `json:"force"`
	}
	if !decode(w, r, &req, true) {
		return
	}
	gen, sess, err := s.store.Acquire(r.Context(), device(r).ID, req.Force, s.now(), s.cfg.OwnerLiveness)
	if err != nil {
		s.storeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"generation": gen, "session": toSessionJSON(sess)})
}

type generationRequest struct {
	Generation *int64 `json:"generation"`
}

func decodeGeneration(w http.ResponseWriter, r *http.Request) (int64, bool) {
	var req generationRequest
	if !decode(w, r, &req, false) {
		return 0, false
	}
	if req.Generation == nil {
		invalid(w, "generation is required")
		return 0, false
	}
	return *req.Generation, true
}

func (s *Server) release(w http.ResponseWriter, r *http.Request) {
	gen, ok := decodeGeneration(w, r)
	if !ok {
		return
	}
	if err := s.store.Release(r.Context(), device(r).ID, gen); err != nil {
		s.storeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) heartbeat(w http.ResponseWriter, r *http.Request) {
	gen, ok := decodeGeneration(w, r)
	if !ok {
		return
	}
	if err := s.store.Heartbeat(r.Context(), device(r).ID, gen, s.now()); err != nil {
		s.storeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) operations(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Generation   *int64            `json:"generation"`
		BaseRevision *int64            `json:"baseRevision"`
		Operations   []json.RawMessage `json:"operations"`
	}
	if !decode(w, r, &req, false) {
		return
	}
	switch {
	case req.Generation == nil:
		invalid(w, "generation is required")
		return
	case req.BaseRevision == nil || *req.BaseRevision < 0:
		invalid(w, "baseRevision must be a non-negative integer")
		return
	case !batchSizeOK(w, len(req.Operations)):
		return
	}
	ops, ok := decodeOps[session.Op](w, req.Operations)
	if !ok {
		return
	}
	// Validate everything before touching state: a bad op rejects the batch.
	for i, op := range ops {
		if err := session.Validate(op); err != nil {
			invalid(w, fmt.Sprintf("operations[%d]: %v", i, err))
			return
		}
	}
	res, err := s.store.ApplyOperations(r.Context(), device(r).ID, *req.Generation, *req.BaseRevision,
		ops, s.now(), s.cfg.SnapshotRetention)
	if err != nil {
		s.storeError(w, r, err)
		return
	}
	body := map[string]any{"revision": res.Revision, "results": results(res.Results)}
	if res.FullResync {
		body["fullResync"] = true
	} else {
		body["catchUp"] = map[string]any{"operations": res.CatchUp}
	}
	writeJSON(w, http.StatusOK, body)
}

// decodeOps decodes each operation strictly: an unknown field (such as a
// plaintext url) is 400 invalid_request for the whole batch. Unknown
// top-level fields stay ignored.
func decodeOps[T any](w http.ResponseWriter, raw []json.RawMessage) ([]T, bool) {
	out := make([]T, len(raw))
	for i, m := range raw {
		dec := json.NewDecoder(bytes.NewReader(m))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&out[i]); err != nil {
			invalid(w, fmt.Sprintf("operations[%d]: must be an operation object without unknown fields", i))
			return nil, false
		}
	}
	return out, true
}

// batchSizeOK writes 413 and returns false when a batch has too many operations.
func batchSizeOK(w http.ResponseWriter, n int) bool {
	if n <= session.MaxBatchOps {
		return true
	}
	writeError(w, http.StatusRequestEntityTooLarge, "payload_too_large",
		fmt.Sprintf("at most %d operations per batch", session.MaxBatchOps), nil)
	return false
}

func (s *Server) merge(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Operations []json.RawMessage `json:"operations"`
	}
	if !decode(w, r, &req, false) || !batchSizeOK(w, len(req.Operations)) {
		return
	}
	ops, ok := decodeOps[session.MergeOp](w, req.Operations)
	if !ok {
		return
	}
	for i, op := range ops {
		if op.BaseRevision == nil || *op.BaseRevision < 0 {
			invalid(w, fmt.Sprintf("operations[%d]: baseRevision must be a non-negative integer", i))
			return
		}
		if err := session.Validate(op.Op); err != nil {
			invalid(w, fmt.Sprintf("operations[%d]: %v", i, err))
			return
		}
	}
	res, err := s.store.Merge(r.Context(), device(r).ID, ops, s.now(), s.cfg.SnapshotRetention)
	if err != nil {
		s.storeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revision": res.Revision, "results": results(res.Results)})
}

func (s *Server) listSnapshots(w http.ResponseWriter, r *http.Request) {
	snaps, err := s.store.ListSnapshots(r.Context(), device(r).ID)
	if err != nil {
		s.storeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"snapshots": snaps})
}

func (s *Server) restore(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "not found", nil)
		return
	}
	gen, ok := decodeGeneration(w, r)
	if !ok {
		return
	}
	res, err := s.store.RestoreSnapshot(r.Context(), device(r).ID, gen, id, s.now(), s.cfg.SnapshotRetention)
	if err != nil {
		s.storeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revision": res.Revision, "results": results(res.Results)})
}

// Limits for POST /v3/diag.
const (
	maxDiagLines    = 200
	maxDiagLineRune = 300
)

// diag logs client diagnostics lines (CTS_DEBUG only). The extension sends
// event kinds, tab ids, entry id prefixes and run results, never URLs or tokens.
func (s *Server) diag(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Lines []string `json:"lines"`
	}
	if !decode(w, r, &req, false) {
		return
	}
	if len(req.Lines) > maxDiagLines {
		invalid(w, fmt.Sprintf("at most %d lines", maxDiagLines))
		return
	}
	for _, l := range req.Lines {
		if utf8.RuneCountInString(l) > maxDiagLineRune {
			invalid(w, fmt.Sprintf("lines must be at most %d characters", maxDiagLineRune))
			return
		}
	}
	id := device(r).ID
	for _, l := range req.Lines {
		s.log.LogAttrs(r.Context(), slog.LevelInfo, "diag", slog.String("device_id", id), slog.String("line", l))
	}
	w.WriteHeader(http.StatusNoContent)
}
