//go:build windows

package main

import (
	"strings"
	"testing"
	"time"
)

func TestSpawnOnWindowsUsesOneshot(t *testing.T) {
	s := newSupervisor()
	p, err := s.spawn("w1", "echo hello-oneshot")
	if err != nil {
		t.Fatal(err)
	}
	if p.cmd == nil {
		t.Fatal("Windows spawn must use cmd /C oneshot, not a live PTY")
	}
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		p.mu.Lock()
		running := p.running
		out := ""
		if p.stdout != nil {
			out = p.stdout.render()
		}
		p.mu.Unlock()
		if !running && strings.Contains(out, "hello-oneshot") {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("oneshot job did not finish with hello-oneshot")
}
