package main

import (
	"bytes"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/kaanemec/cross-tab-sync/server/internal/config"
)

func TestPairCodeOutput(t *testing.T) {
	t.Parallel()
	cfg := config.Default()
	cfg.DBPath = filepath.Join(t.TempDir(), "cts.db")

	var out, errOut bytes.Buffer
	if err := pairCode(cfg, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[A-Z2-9]{8}\n$`).MatchString(out.String()) {
		t.Fatalf("stdout without CTS_PUBLIC_URL = %q, want a bare code", out.String())
	}
	if !strings.Contains(errOut.String(), "CTS_PUBLIC_URL") {
		t.Fatalf("stderr lacks the CTS_PUBLIC_URL hint: %q", errOut.String())
	}
	if !strings.Contains(errOut.String(), "first browser only") {
		t.Fatalf("stderr lacks the first-browser hint: %q", errOut.String())
	}

	cfg.PublicURL = "https://tabs.example.com"
	out.Reset()
	errOut.Reset()
	if err := pairCode(cfg, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^https://tabs\.example\.com#[A-Z2-9]{8}\n$`).MatchString(out.String()) {
		t.Fatalf("stdout with CTS_PUBLIC_URL = %q, want a pairing link", out.String())
	}
	if strings.Contains(errOut.String(), "CTS_PUBLIC_URL") {
		t.Fatalf("hint printed although CTS_PUBLIC_URL is set: %q", errOut.String())
	}
}
