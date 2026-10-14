package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/kaanemec/cross-tab-sync/server/internal/config"
)

func TestDiagDisabledByDefault(t *testing.T) {
	t.Parallel()
	e := newEnv(t, nil)
	a := e.pair("A")
	var er errorJSON
	e.expect(http.StatusNotFound, "POST", "/v3/diag", a.Token, map[string]any{"lines": []string{"x"}}, &er)
	if er.Error != "not_found" {
		t.Fatalf("disabled: %+v", er)
	}
	if strings.Contains(e.logs.String(), `"msg":"diag"`) {
		t.Fatal("diag line logged while disabled")
	}
}

func TestDiagLogsLinesWithDebug(t *testing.T) {
	t.Parallel()
	e := newEnv(t, func(c *config.Config) { c.Debug = true })
	a := e.pair("A")
	e.expect(http.StatusUnauthorized, "POST", "/v3/diag", "", map[string]any{"lines": []string{"x"}}, nil)
	e.expect(http.StatusNoContent, "POST", "/v3/diag", a.Token, map[string]any{"lines": []string{"run alarm start", "task release end 3ms"}}, nil)

	var got []string
	for _, line := range strings.Split(strings.TrimSpace(e.logs.String()), "\n") {
		var rec struct {
			Msg      string `json:"msg"`
			Level    string `json:"level"`
			DeviceID string `json:"device_id"`
			Line     string `json:"line"`
		}
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatal(err)
		}
		if rec.Msg != "diag" {
			continue
		}
		if rec.Level != "INFO" || rec.DeviceID != a.ID {
			t.Fatalf("diag record: %+v", rec)
		}
		got = append(got, rec.Line)
	}
	if strings.Join(got, "|") != "run alarm start|task release end 3ms" {
		t.Fatalf("logged lines %q", got)
	}

	var er errorJSON
	tooMany := make([]string, maxDiagLines+1)
	e.expect(http.StatusBadRequest, "POST", "/v3/diag", a.Token, map[string]any{"lines": tooMany}, &er)
	if er.Error != "invalid_request" {
		t.Fatalf("too many lines: %+v", er)
	}
	e.expect(http.StatusBadRequest, "POST", "/v3/diag", a.Token, map[string]any{"lines": []string{strings.Repeat("é", maxDiagLineRune+1)}}, &er)
	e.expect(http.StatusNoContent, "POST", "/v3/diag", a.Token, map[string]any{"lines": []string{strings.Repeat("é", maxDiagLineRune)}}, nil)
}
