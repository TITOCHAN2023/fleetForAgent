//go:build !windows

package pane

import (
	"strings"
	"testing"
	"time"

	"github.com/TITOCHAN2023/fleetForAgent/internal/pane/backend"
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

func TestStartLiveShellPTY(t *testing.T) {
	t.Setenv(backend.EnvVar, "pty")
	ls, err := startLiveShell("pty-live")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(ls.kill)
	if ls.handle == nil {
		t.Fatal("missing backend handle")
	}
	if !ls.alive() {
		t.Fatal("pty live shell dead")
	}
}

func TestStartLiveShellTmuxReattach(t *testing.T) {
	if !backend.Available(backend.TypeTmux) {
		t.Skip("tmux not usable")
	}
	t.Setenv(backend.EnvVar, "tmux")
	name := backend.SessionName("live-tmux")
	t.Cleanup(func() { backend.DestroySession(backend.TypeTmux, name) })

	ls, err := startLiveShell("live-tmux")
	if err != nil {
		t.Fatal(err)
	}
	h, ok := ls.handle.(*backend.Handle)
	if !ok || h == nil {
		ls.kill()
		t.Fatal("missing tmux handle")
	}
	ls.mu.Lock()
	ls.handle = nil
	ls.mu.Unlock()
	h.Detach()

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && backend.ProbeSession(backend.TypeTmux, name) != backend.ProbeExists {
		time.Sleep(50 * time.Millisecond)
	}
	if backend.ProbeSession(backend.TypeTmux, name) != backend.ProbeExists {
		t.Fatal("tmux session died with the viewer")
	}

	ls2, err := startLiveShell("live-tmux")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(ls2.kill)
	h2, ok := ls2.handle.(*backend.Handle)
	if !ok || h2 == nil || !h2.Reattach {
		t.Fatal("expected reattach")
	}
}
