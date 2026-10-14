package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/kaanemec/cross-tab-sync/server/internal/config"
)

type pairingCodeResp struct {
	Code      string `json:"code"`
	ExpiresAt string `json:"expiresAt"`
	Link      string `json:"link"`
}

// createCode calls POST /v1/pairing-codes with the given Host and extra headers.
func (e *env) createCode(d testDevice, host string, headers map[string]string) pairingCodeResp {
	e.t.Helper()
	req, err := http.NewRequest("POST", e.srv.URL+"/v1/pairing-codes", nil)
	if err != nil {
		e.t.Fatal(err)
	}
	if host != "" {
		req.Host = host
	}
	req.Header.Set("Authorization", "Bearer "+d.Token)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := e.srv.Client().Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		e.t.Fatalf("pairing-codes: status %d", resp.StatusCode)
	}
	var out pairingCodeResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		e.t.Fatal(err)
	}
	return out
}

type pairResp struct {
	testDevice
	Name string `json:"name"`
}

// pairAs pairs a device with name and returns the response including the stored name.
func (e *env) pairAs(name string) pairResp {
	e.t.Helper()
	code, _, err := e.st.CreatePairingCode(context.Background(), "", e.clock.Now())
	if err != nil {
		e.t.Fatal(err)
	}
	var r pairResp
	e.expect(http.StatusCreated, "POST", "/v1/pair", "", map[string]string{"code": code, "name": name, "browser": "brave"}, &r)
	return r
}

type deviceResp struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Browser   string  `json:"browser"`
	IsSelf    bool    `json:"isSelf"`
	RevokedAt *string `json:"revokedAt"`
}

func (e *env) devices(d testDevice) []deviceResp {
	e.t.Helper()
	var r struct {
		Devices []deviceResp `json:"devices"`
	}
	e.expect(http.StatusOK, "GET", "/v1/devices", d.Token, nil, &r)
	return r.Devices
}

func TestPairingLinkFromRequest(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a := e.pair("A")
	host := strings.TrimPrefix(e.srv.URL, "http://")

	for _, tc := range []struct {
		name, host string
		headers    map[string]string
		wantBase   string
	}{
		{"plain http", "", nil, "http://" + host},
		{"forwarded https", "tabs.example.com", map[string]string{"X-Forwarded-Proto": "https"}, "https://tabs.example.com"},
		{"forwarded http", "127.0.0.1:8080", map[string]string{"X-Forwarded-Proto": "http"}, "http://127.0.0.1:8080"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := e.createCode(a, tc.host, tc.headers)
			if len(r.Code) != 8 || r.Link != tc.wantBase+"#"+r.Code {
				t.Fatalf("link %q for code %q, want %s#%s", r.Link, r.Code, tc.wantBase, r.Code)
			}
		})
	}

	// The link's code pairs a new device.
	r := e.createCode(a, "", nil)
	_, code, _ := strings.Cut(r.Link, "#")
	var d testDevice
	e.expect(http.StatusCreated, "POST", "/v1/pair", "", map[string]string{"code": code, "name": "B", "browser": "safari"}, &d)
}

func TestPairingLinkFromPublicURL(t *testing.T) {
	t.Parallel()
	e := newEnv(t, func(c *config.Config) { c.PublicURL = "https://tabs.example.com/cts" })
	a := e.pair("A")
	r := e.createCode(a, "internal:8080", map[string]string{"X-Forwarded-Proto": "http"})
	if r.Link != "https://tabs.example.com/cts#"+r.Code {
		t.Fatalf("link %q", r.Link)
	}
}

func TestDuplicateNamesAreSuffixed(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	names := func(rs ...pairResp) []string {
		out := make([]string, len(rs))
		for i, r := range rs {
			out[i] = r.Name
		}
		return out
	}
	a, b, c := e.pairAs("Brave on macOS"), e.pairAs("Brave on macOS"), e.pairAs("brave on MACOS")
	if got := strings.Join(names(a, b, c), "|"); got != "Brave on macOS|Brave on macOS 2|brave on MACOS 3" {
		t.Fatalf("paired names %q", got)
	}

	// A revoked device frees its name; the lowest free suffix is used.
	e.expect(http.StatusNoContent, "DELETE", "/v1/devices/"+b.ID, a.Token, nil, nil)
	if d := e.pairAs("Brave on macOS"); d.Name != "Brave on macOS 2" {
		t.Fatalf("after revoke: %q", d.Name)
	}

	// Long names are shortened to fit 64 characters with the suffix.
	long := strings.Repeat("x", 64)
	e.pairAs(long)
	if d := e.pairAs(long); d.Name != strings.Repeat("x", 62)+" 2" {
		t.Fatalf("long name %q", d.Name)
	}

	// Rename: same rule, and renaming to one's own name keeps it.
	var dev deviceResp
	e.expect(http.StatusOK, "PATCH", "/v1/devices/"+c.ID, c.Token, map[string]string{"name": "Brave on macOS"}, &dev)
	if dev.Name != "Brave on macOS 3" || !dev.IsSelf || dev.ID != c.ID {
		t.Fatalf("rename to taken name: %+v", dev)
	}
	e.expect(http.StatusOK, "PATCH", "/v1/devices/"+c.ID, c.Token, map[string]string{"name": "Brave on macOS 3"}, &dev)
	if dev.Name != "Brave on macOS 3" {
		t.Fatalf("rename to own name: %+v", dev)
	}
}

func TestRenameDevice(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a, b := e.pair("A"), e.pair("B")
	e.acquire(a, false)

	var dev deviceResp
	e.expect(http.StatusOK, "PATCH", "/v1/devices/"+a.ID, a.Token, map[string]string{"name": "  Work Mac  "}, &dev)
	if dev.Name != "Work Mac" || dev.Browser != "brave" || !dev.IsSelf {
		t.Fatalf("renamed: %+v", dev)
	}
	if s := e.session(b); s.Owner == nil || s.Owner.Name != "Work Mac" {
		t.Fatalf("owner name after rename: %+v", s.Owner)
	}
	for _, d := range e.devices(b) {
		if d.ID == a.ID && d.Name != "Work Mac" {
			t.Fatalf("listed name %q", d.Name)
		}
	}

	var er errorJSON
	e.expect(http.StatusForbidden, "PATCH", "/v1/devices/"+b.ID, a.Token, map[string]string{"name": "Mine"}, &er)
	if er.Error != "forbidden" {
		t.Fatalf("rename other: %+v", er)
	}
	for _, bad := range []any{map[string]string{"name": "   "}, map[string]string{"name": strings.Repeat("n", 65)}, map[string]int{"name": 1}} {
		e.expect(http.StatusBadRequest, "PATCH", "/v1/devices/"+a.ID, a.Token, bad, &er)
		if er.Error != "invalid_request" {
			t.Fatalf("rename %v: %+v", bad, er)
		}
	}
	e.expect(http.StatusOK, "PATCH", "/v1/devices/"+a.ID, a.Token, map[string]string{"name": strings.Repeat("n", 64)}, &dev)
}

func TestRevokedDevicesListedForSevenDays(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a := e.pair("A")
	e.clock.Advance(time.Second) // distinct createdAt: equal ones are ordered by random id
	b := e.pair("B")
	e.clock.Advance(time.Second)
	c := e.pair("C")
	e.expect(http.StatusNoContent, "DELETE", "/v1/devices/"+b.ID, a.Token, nil, nil)
	revokedAt := e.clock.Now()

	ds := e.devices(a)
	if len(ds) != 3 || ds[0].ID != a.ID || ds[1].ID != c.ID || ds[2].ID != b.ID {
		t.Fatalf("order: %+v", ds)
	}
	if ds[0].RevokedAt != nil || ds[1].RevokedAt != nil || !ds[0].IsSelf {
		t.Fatalf("active devices: %+v", ds[:2])
	}
	if ds[2].RevokedAt == nil || *ds[2].RevokedAt != revokedAt.UTC().Format("2006-01-02T15:04:05.000Z") || ds[2].Name != "B" {
		t.Fatalf("revoked device: %+v", ds[2])
	}

	e.clock.Advance(7*24*time.Hour - time.Minute)
	if ds := e.devices(a); len(ds) != 3 {
		t.Fatalf("just under 7 days: %d devices", len(ds))
	}
	e.clock.Advance(2 * time.Minute)
	if ds := e.devices(a); len(ds) != 2 {
		t.Fatalf("after 7 days: %+v", ds)
	}
	// A revoked device cannot rename itself.
	var er errorJSON
	e.expect(http.StatusUnauthorized, "PATCH", "/v1/devices/"+b.ID, b.Token, map[string]string{"name": "X"}, &er)
	if er.Error != "device_revoked" {
		t.Fatalf("%+v", er)
	}
}
