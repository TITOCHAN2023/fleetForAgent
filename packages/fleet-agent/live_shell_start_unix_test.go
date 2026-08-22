//go:build !windows

package main

import (
	"strings"
	"testing"
)

func TestLiveShellEnvDropsNoColor(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	t.Setenv("FORCE_COLOR", "0")
	t.Setenv("TERM", "dumb")
	for _, e := range liveShellEnv() {
		if strings.HasPrefix(e, "NO_COLOR=") || strings.HasPrefix(e, "FORCE_COLOR=") {
			t.Fatalf("launcher color env leaked: %q", e)
		}
		if e == "TERM=dumb" {
			t.Fatal("TERM=dumb must not win")
		}
	}
}
