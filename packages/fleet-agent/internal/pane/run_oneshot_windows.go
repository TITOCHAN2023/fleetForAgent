//go:build windows

package pane

import (
	"github.com/TITOCHAN2023/fleetForAgent/internal/hostaudit"
	"os/exec"
)

func (s *Supervisor) spawnOneshotPTYObserved(fingerprint, corr, command string, _ func(*exec.Cmd) (*exec.Cmd, hostaudit.Session, error)) (*Pane, error) {
	return s.spawnOneshotFor(fingerprint, corr, command)
}

func (s *Supervisor) spawnOneshotPTY(fingerprint, corr, command string) (*Pane, error) {
	return s.spawnOneshotFor(fingerprint, corr, command)
}

func (p *Pane) finishOneshot(code int) {
	if p == nil {
		return
	}
	p.mu.Lock()
	out := ""
	if p.stdout != nil {
		out = p.stdout.render()
	}
	p.mu.Unlock()
	p.finishCommand(out, code)
}
