// Package api implements the HTTP API described in docs/PROTOCOL.md.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/kaanemec/cross-tab-sync/server/internal/config"
	"github.com/kaanemec/cross-tab-sync/server/internal/session"
	"github.com/kaanemec/cross-tab-sync/server/internal/store"
)

// Server holds the handler dependencies.
type Server struct {
	store *store.Store
	cfg   config.Config
	log   *slog.Logger
	now   func() time.Time
}

// New returns the API handler. now may be nil (time.Now).
func New(st *store.Store, cfg config.Config, log *slog.Logger, now func() time.Time) http.Handler {
	if now == nil {
		now = time.Now
	}
	s := &Server{store: st, cfg: cfg, log: log, now: now}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("POST /v2/pair", s.pair)
	mux.Handle("POST /v2/pairing-codes", s.auth(s.createPairingCode))
	mux.Handle("GET /v2/devices", s.auth(s.listDevices))
	mux.Handle("PATCH /v2/devices/{id}", s.auth(s.renameDevice))
	mux.Handle("DELETE /v2/devices/{id}", s.auth(s.revokeDevice))
	mux.Handle("GET /v2/session", s.auth(s.getSession))
	mux.Handle("PUT /v2/session/key", s.auth(s.setKeyCheck))
	mux.Handle("GET /v2/session/changes", s.auth(s.changes))
	mux.Handle("POST /v2/session/acquire", s.auth(s.acquire))
	mux.Handle("POST /v2/session/release", s.auth(s.release))
	mux.Handle("POST /v2/session/heartbeat", s.auth(s.heartbeat))
	mux.Handle("POST /v2/session/operations", s.auth(s.operations))
	mux.Handle("POST /v2/session/merge", s.auth(s.merge))
	mux.Handle("GET /v2/snapshots", s.auth(s.listSnapshots))
	mux.Handle("POST /v2/snapshots/{id}/restore", s.auth(s.restore))
	if cfg.Debug {
		// Development aid only; without CTS_DEBUG the path falls through to 404 not_found.
		mux.Handle("POST /v2/diag", s.auth(s.diag))
	}
	// Everything else, including the retired /v1 routes, is 404 not_found.
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "no such endpoint", nil)
	})
	return s.logRequests(mux, s.requireHTTPS(mux))
}

type ctxKey int

const (
	infoKey ctxKey = iota
	deviceKey
)

// reqInfo is filled in by inner handlers for the access log.
type reqInfo struct {
	deviceID string
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	if r.status == 0 {
		r.status = code
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.ResponseWriter.Write(b)
}

func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// logRequests logs method, path, status, device id and latency only. Query
// strings, bodies and headers are never logged.
func (s *Server) logRequests(mux *http.ServeMux, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		info := &reqInfo{}
		r = r.WithContext(context.WithValue(r.Context(), infoKey, info))
		rec := &statusRecorder{ResponseWriter: w}
		h := rec.Header()
		h.Set("Cache-Control", "no-store")
		h.Set("X-Content-Type-Options", "nosniff")

		defer func() {
			if p := recover(); p != nil {
				if err, ok := p.(error); ok && errors.Is(err, http.ErrAbortHandler) {
					panic(p)
				}
				s.log.LogAttrs(r.Context(), slog.LevelError, "handler panic", slog.String("route", r.Pattern))
				if rec.status == 0 {
					writeError(rec, http.StatusInternalServerError, "internal", "internal error", nil)
				}
			}
			// Log the route pattern, never the raw path: wildcard segments
			// and unmatched paths are client-controlled.
			pattern := r.Pattern
			if pattern == "" { // rejected before routing
				_, pattern = mux.Handler(r)
			}
			_, path, _ := strings.Cut(pattern, " ")
			if path == "" || path == "/" {
				path = "(unmatched)"
			}
			status := rec.status
			if status == 0 {
				status = http.StatusOK
			}
			s.log.LogAttrs(r.Context(), slog.LevelInfo, "request",
				slog.String("method", r.Method),
				slog.String("path", path),
				slog.Int("status", status),
				slog.String("device_id", info.deviceID),
				slog.Float64("latency_ms", float64(time.Since(start).Microseconds())/1000),
			)
		}()
		next.ServeHTTP(rec, r)
	})
}

// requireHTTPS rejects plain HTTP unless CTS_ALLOW_INSECURE is set. TLS is
// normally terminated by Caddy, which sets X-Forwarded-Proto.
func (s *Server) requireHTTPS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.cfg.AllowInsecure && r.URL.Path != "/healthz" && r.TLS == nil &&
			!strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
			writeError(w, http.StatusForbidden, "invalid_request", "HTTPS is required", nil)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// auth resolves the bearer token and stores the device in the context.
func (s *Server) auth(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		const scheme = "bearer "
		if len(h) <= len(scheme) || !strings.EqualFold(h[:len(scheme)], scheme) {
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeError(w, http.StatusUnauthorized, "unauthorized", "missing bearer token", nil)
			return
		}
		dev, err := s.store.Authenticate(r.Context(), strings.TrimSpace(h[len(scheme):]), s.now())
		switch {
		case errors.Is(err, store.ErrRevoked):
			writeError(w, http.StatusUnauthorized, "device_revoked", "this device has been revoked; pair again", nil)
			return
		case errors.Is(err, store.ErrUnauthorized):
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeError(w, http.StatusUnauthorized, "unauthorized", "invalid token", nil)
			return
		case err != nil:
			s.internal(w, r, err)
			return
		}
		if info, ok := r.Context().Value(infoKey).(*reqInfo); ok {
			info.deviceID = dev.ID
		}
		next(w, r.WithContext(context.WithValue(r.Context(), deviceKey, dev)))
	})
}

func device(r *http.Request) store.Device {
	d, _ := r.Context().Value(deviceKey).(store.Device)
	return d
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v) // the client may have gone away; nothing to do
}

// writeError writes {"error": code, "message": msg, ...details}.
func writeError(w http.ResponseWriter, status int, code, msg string, details map[string]any) {
	body := make(map[string]any, len(details)+2)
	for k, v := range details {
		body[k] = v
	}
	body["error"] = code
	body["message"] = msg
	writeJSON(w, status, body)
}

func (s *Server) internal(w http.ResponseWriter, r *http.Request, err error) {
	s.log.LogAttrs(r.Context(), slog.LevelError, "internal error",
		slog.String("route", r.Pattern), slog.String("error", err.Error()))
	writeError(w, http.StatusInternalServerError, "internal", "internal error", nil)
}

// storeError maps store errors to protocol errors.
func (s *Server) storeError(w http.ResponseWriter, r *http.Request, err error) {
	var ce *store.ConflictError
	switch {
	case errors.As(err, &ce):
		msg := "the caller is not the current owner or its generation is stale"
		if ce.Code == store.CodeOwnerActive {
			msg = "another device owns the session"
		}
		writeError(w, http.StatusConflict, ce.Code, msg, map[string]any{"owner": ce.Owner})
	case errors.Is(err, store.ErrRevoked):
		writeError(w, http.StatusUnauthorized, "device_revoked", "this device has been revoked; pair again", nil)
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "not found", nil)
	case errors.Is(err, store.ErrKeySet):
		writeError(w, http.StatusConflict, "key_set", "a different key check is already set", nil)
	case errors.Is(err, store.ErrHistoryExpired):
		writeError(w, http.StatusGone, "history_expired", "history is not available; fetch the full session", nil)
	default:
		s.internal(w, r, err)
	}
}

// decode reads one JSON value from a body of at most session.MaxBodyBytes.
// An empty body is accepted when allowEmpty is set. It writes the error
// response and returns false on failure. Unknown fields are ignored.
func decode(w http.ResponseWriter, r *http.Request, dst any, allowEmpty bool) bool {
	r.Body = http.MaxBytesReader(w, r.Body, session.MaxBodyBytes)
	dec := json.NewDecoder(r.Body)
	err := dec.Decode(dst)
	if err == nil {
		if _, terr := dec.Token(); !errors.Is(terr, io.EOF) {
			err = terr
			if err == nil {
				err = errors.New("trailing data")
			}
		}
	} else if errors.Is(err, io.EOF) && allowEmpty {
		return true
	}
	if err == nil {
		return true
	}
	var mbe *http.MaxBytesError
	if errors.As(err, &mbe) {
		writeError(w, http.StatusRequestEntityTooLarge, "payload_too_large", "request body exceeds 256 KiB", nil)
		return false
	}
	writeError(w, http.StatusBadRequest, "invalid_request", "body must be a single JSON object", nil)
	return false
}

func invalid(w http.ResponseWriter, msg string) {
	writeError(w, http.StatusBadRequest, "invalid_request", msg, nil)
}
