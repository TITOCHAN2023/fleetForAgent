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
	got := map[string]string{}
	for _, e := range liveShellEnv() {
		if strings.HasPrefix(e, "NO_COLOR=") || strings.HasPrefix(e, "FORCE_COLOR=") {
			t.Fatalf("launcher color env leaked: %q", e)
		}
		if e == "TERM=dumb" {
			t.Fatal("TERM=dumb must not win")
		}
		k, v, _ := strings.Cut(e, "=")
		got[k] = v
	}
	if got["PAGER"] != "cat" || got["GIT_PAGER"] != "cat" {
		t.Fatalf("pagers=%q %q", got["PAGER"], got["GIT_PAGER"])
	}
	if got["LANG"] != "C.UTF-8" {
		t.Fatalf("LANG=%q", got["LANG"])
	}
}
