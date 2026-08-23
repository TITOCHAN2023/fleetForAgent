//go:build windows

package main

func (s *supervisor) spawnOneshotPTY(fingerprint, corr, command string) (*pane, error) {
	return s.spawnOneshotFor(fingerprint, corr, command)
}

func (p *pane) finishOneshot(code int) {
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
