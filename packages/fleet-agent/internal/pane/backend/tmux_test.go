//go:build !windows

package backend

import (
	"os"
	"testing"
	"time"
)

func TestOpenPTYEcho(t *testing.T) {
	h, err := OpenType(TypePTY, "", SpawnOpts{
		Bin:  "/bin/sh",
		Args: []string{"-c", "printf hi"},
		Env:  os.Environ(),
		Cols: 80,
		Rows: 24,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Destroy()
	deadline := time.Now().Add(5 * time.Second)
	buf := make([]byte, 64)
	var n int
	for time.Now().Before(deadline) {
		_ = h.File.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
		n, err = h.File.Read(buf)
		if n > 0 {
			break
		}
	}
	if n == 0 {
		t.Fatalf("no pty output: %v", err)
	}
}

func TestTmuxReattachSurvivesDetach(t *testing.T) {
	if !tmuxAvailable() {
		t.Skip("tmux not usable")
	}
	name := SessionName("test-reattach")
	t.Cleanup(func() { killTmuxSession(name) })
	killTmuxSession(name)

	opts := SpawnOpts{
		Bin:  "/bin/sleep",
		Args: []string{"60"},
		Env:  os.Environ(),
		Cols: 80,
		Rows: 24,
	}
	h, err := OpenType(TypeTmux, name, opts)
	if err != nil {
		t.Fatal(err)
	}
	if h.Reattach {
		h.Destroy()
		t.Fatal("first spawn should be new")
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && ProbeSession(TypeTmux, name) != ProbeExists {
		time.Sleep(50 * time.Millisecond)
	}
	if ProbeSession(TypeTmux, name) != ProbeExists {
		h.Destroy()
		t.Fatal("tmux session never appeared")
	}
	h.Detach()

	h2, err := OpenType(TypeTmux, name, opts)
	if err != nil {
		t.Fatal(err)
	}
	defer h2.Destroy()
	if !h2.Reattach {
		t.Fatal("expected reattach to surviving session")
	}
	if ProbeSession(TypeTmux, name) != ProbeExists {
		t.Fatal("session missing after reattach")
	}
	h2.Destroy()
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && ProbeSession(TypeTmux, name) == ProbeExists {
		time.Sleep(50 * time.Millisecond)
	}
	if ProbeSession(TypeTmux, name) == ProbeExists {
		t.Fatal("destroy left the session running")
	}
}

func TestTmuxFreshKillsLeftover(t *testing.T) {
	if !tmuxAvailable() {
		t.Skip("tmux not usable")
	}
	name := RunSessionName("fresh-corr")
	t.Cleanup(func() { killTmuxSession(name) })
	h, err := OpenType(TypeTmux, name, SpawnOpts{
		Bin:  "/bin/sleep",
		Args: []string{"60"},
		Env:  os.Environ(),
		Cols: 80,
		Rows: 24,
	})
	if err != nil {
		t.Fatal(err)
	}
	h.Detach()
	h2, err := OpenType(TypeTmux, name, SpawnOpts{
		Bin:   "/bin/sh",
		Args:  []string{"-c", "printf ok"},
		Env:   os.Environ(),
		Cols:  80,
		Rows:  24,
		Fresh: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer h2.Destroy()
	if h2.Reattach {
		t.Fatal("Fresh must not reattach")
	}
}

func TestTmuxGateWhenForcedMissing(t *testing.T) {
	g := DecideGate(TypeTmux, false, false, false)
	if g.Action != GateRefuse {
		t.Fatalf("%+v", g)
	}
}
