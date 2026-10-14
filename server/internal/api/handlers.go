package api

import (
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
	URL             string `json:"url"`
	Pinned          bool   `json:"pinned"`
	Position        int64  `json:"position"`
	UpdatedRevision int64  `json:"updatedRevision"`
}

type sessionJSON struct {
	Revision    int64        `json:"revision"`
	MinRevision int64        `json:"minRevision"`
	Owner       *store.Owner `json:"owner"`
	Entries     []entryJSON  `json:"entries"`
}

func toSessionJSON(s store.Session) sessionJSON {
	out := sessionJSON{Revision: s.Revision, MinRevision: s.MinRevision, Owner: s.Owner, Entries: make([]entryJSON, len(s.Entries))}
	for i, e := range s.Entries {
		out.Entries[i] = entryJSON{ID: e.ID, URL: e.URL, Pinned: e.Pinned, Position: e.Position, UpdatedRevision: e.UpdatedRevision}
	}
	return out
}

func results(rs []session.Result) []session.Result {
	if rs == nil {
		return []session.Result{}
	}
	return rs
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

func (s *Server) pair(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code    string `json:"code"`
		Name    string `json:"name"`
		Browser string `json:"browser"`
	}
	if !decode(w, r, &req, false) {
		return
	}
	name, ok := validLabel(req.Name, session.MaxNameLength)
	if !ok {
		invalid(w, fmt.Sprintf("name must be 1..%d printable characters", session.MaxNameLength))
		return
	}
	browser, ok := validLabel(req.Browser, 32)
	if !ok {
		invalid(w, "browser must be 1..32 printable characters")
		return
	}
	dev, token, err := s.store.Pair(r.Context(), req.Code, name, browser, s.now())
	if errors.Is(err, store.ErrInvalidCode) {
		writeError(w, http.StatusBadRequest, "invalid_code", "pairing code is invalid, used or expired", nil)
		return
	}
	if err != nil {
		s.internal(w, r, err)
		return
	}
	if info, ok := r.Context().Value(infoKey).(*reqInfo); ok {
		info.deviceID = dev.ID
	}
	writeJSON(w, http.StatusCreated, map[string]string{"deviceId": dev.ID, "token": token, "name": dev.Name})
}

// PairingLink is the link a new browser pastes to pair: the server's public
// base URL with the code as the fragment.
func PairingLink(base, code string) string {
	return base + "#" + code
}

// publicBase is CTS_PUBLIC_URL, or else the scheme (TLS or X-Forwarded-Proto)
// and Host the request arrived with.
func (s *Server) publicBase(r *http.Request) string {
	if s.cfg.PublicURL != "" {
		return s.cfg.PublicURL
	}
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

func (s *Server) createPairingCode(w http.ResponseWriter, r *http.Request) {
	code, expires, err := s.store.CreatePairingCode(r.Context(), device(r).ID, s.now())
	if err != nil {
		s.storeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"code": code, "expiresAt": store.Timestamp{Time: expires}, "link": PairingLink(s.publicBase(r), code),
	})
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
	ds, err := s.store.ListDevices(r.Context(), s.now())
	if err != nil {
		s.internal(w, r, err)
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
	sess, err := s.store.GetSession(r.Context())
	if err != nil {
		s.internal(w, r, err)
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
	cs, err := s.store.Changes(r.Context(), since)
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
		Generation   *int64       `json:"generation"`
		BaseRevision *int64       `json:"baseRevision"`
		Operations   []session.Op `json:"operations"`
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
	// Validate everything before touching state: a bad op rejects the batch.
	for i, op := range req.Operations {
		if err := session.Validate(op); err != nil {
			invalid(w, fmt.Sprintf("operations[%d]: %v", i, err))
			return
		}
	}
	res, err := s.store.ApplyOperations(r.Context(), device(r).ID, *req.Generation, *req.BaseRevision,
		req.Operations, s.now(), s.cfg.SnapshotRetention)
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
		Operations []session.MergeOp `json:"operations"`
	}
	if !decode(w, r, &req, false) || !batchSizeOK(w, len(req.Operations)) {
		return
	}
	for i, op := range req.Operations {
		if op.BaseRevision == nil || *op.BaseRevision < 0 {
			invalid(w, fmt.Sprintf("operations[%d]: baseRevision must be a non-negative integer", i))
			return
		}
		if err := session.Validate(op.Op); err != nil {
			invalid(w, fmt.Sprintf("operations[%d]: %v", i, err))
			return
		}
	}
	res, err := s.store.Merge(r.Context(), device(r).ID, req.Operations, s.now(), s.cfg.SnapshotRetention)
	if err != nil {
		s.storeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revision": res.Revision, "results": results(res.Results)})
}

func (s *Server) listSnapshots(w http.ResponseWriter, r *http.Request) {
	snaps, err := s.store.ListSnapshots(r.Context())
	if err != nil {
		s.internal(w, r, err)
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

// Limits for POST /v1/diag.
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
