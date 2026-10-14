package api

import (
	"math"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Budget shared by POST /v3/sessions and POST /v3/pair per client.
const (
	rateLimit   = 10
	rateWindow  = 10 * time.Minute
	rateClients = 10_000 // clients tracked at once; beyond it new clients wait
)

// limiter counts requests per client key in fixed windows. It lives in
// memory only and holds at most rateClients keys: expired windows are swept
// once per window, or at once when the map is full.
type limiter struct {
	mu        sync.Mutex
	windows   map[string]window
	lastSweep time.Time
}

type window struct {
	start time.Time
	count int
}

func newLimiter() *limiter { return &limiter{windows: map[string]window{}} }

func (l *limiter) sweep(now time.Time) {
	for k, w := range l.windows {
		if now.Sub(w.start) >= rateWindow {
			delete(l.windows, k)
		}
	}
	l.lastSweep = now
}

// allow counts one request from key at now. Over the budget, or when a new
// key finds the map full, it returns false and how long to wait.
func (l *limiter) allow(key string, now time.Time) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.lastSweep) >= rateWindow {
		l.sweep(now)
	}
	w, ok := l.windows[key]
	if !ok && len(l.windows) >= rateClients {
		if l.sweep(now); len(l.windows) >= rateClients {
			return false, rateWindow
		}
	}
	if !ok || now.Sub(w.start) >= rateWindow {
		w = window{start: now}
	}
	w.count++
	l.windows[key] = w
	if w.count <= rateLimit {
		return true, 0
	}
	return false, w.start.Add(rateWindow).Sub(now)
}

// clientKey identifies the client for the rate limit: the first entry of the
// header named by CTS_CLIENT_IP_HEADER (for example CF-Connecting-IP) when
// set, else the last X-Forwarded-For entry (the one the reverse proxy
// appended or set), else the connection address. A missing or unparsable
// value falls through to the next rule. IPv6 addresses are keyed by their /64,
// which one client usually holds whole. It is never logged.
func clientKey(r *http.Request, header string) string {
	var (
		ip netip.Addr
		ok bool
	)
	if header != "" {
		first, _, _ := strings.Cut(r.Header.Get(header), ",")
		ip, ok = parseIP(first)
	}
	if vs := r.Header.Values("X-Forwarded-For"); !ok && len(vs) > 0 {
		last := vs[len(vs)-1]
		if i := strings.LastIndexByte(last, ','); i >= 0 {
			last = last[i+1:]
		}
		ip, ok = parseIP(last)
	}
	if !ok {
		ip, _ = parseIP(r.RemoteAddr) // always host:port from net/http
	}
	if ip.Is6() {
		ip = netip.PrefixFrom(ip, 64).Masked().Addr()
	}
	return ip.String()
}

// parseIP parses an address with an optional port, dropping any zone and
// unmapping IPv4-mapped IPv6 addresses.
func parseIP(s string) (netip.Addr, bool) {
	s = strings.TrimSpace(s)
	if ap, err := netip.ParseAddrPort(s); err == nil {
		return ap.Addr().WithZone("").Unmap(), true
	}
	ip, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Addr{}, false
	}
	return ip.WithZone("").Unmap(), true
}

// rateLimit answers 429 rate_limited with Retry-After once the client has
// used its budget; every request counts.
func (s *Server) rateLimit(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ok, wait := s.limiter.allow(clientKey(r, s.cfg.ClientIPHeader), s.now()); !ok {
			w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(wait.Seconds()))))
			writeError(w, http.StatusTooManyRequests, "rate_limited", "too many requests; retry later", nil)
			return
		}
		next(w, r)
	})
}
