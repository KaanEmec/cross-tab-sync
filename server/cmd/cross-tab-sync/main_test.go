package main

import (
	"bytes"
	"strings"
	"testing"
)

// The CLI is serve only; sessions and invites come from the extension.
func TestRunCommands(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		args []string
		code int
	}{
		{[]string{"help"}, 0},
		{nil, 2},
		{[]string{"pair-code"}, 2},
		{[]string{"serve", "extra"}, 2},
	} {
		var out, errOut bytes.Buffer
		if got := run(tc.args, &out, &errOut); got != tc.code {
			t.Errorf("run(%q) = %d, want %d", tc.args, got, tc.code)
		}
		usage := out.String() + errOut.String()
		if !strings.Contains(usage, "serve") || strings.Contains(usage, "pair-code") || strings.Contains(usage, "CTS_PUBLIC_URL") {
			t.Errorf("run(%q) usage: %q", tc.args, usage)
		}
	}
}
