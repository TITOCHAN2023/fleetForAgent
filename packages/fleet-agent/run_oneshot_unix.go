//go:build !windows

package main

import (
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/creack/pty"
)

func (s *supervisor) spawnOneshotPTY(fingerprint, corr, command string) (*pane, error) {
	cmd := exec.Command(pickShell(), "-c", command)
	if home := userHome(); home != "" {
		cmd.Dir = home
	}
	cmd.Env = runCommandEnv()

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: livePtyRows, Cols: livePtyCols})
	if err != nil {
		return nil, fmt.Errorf("pty start: %w", err)
	}
	disableMasterEcho(ptmx)

	p := &pane{
		id:          "pane-" + corr,
		corr:        corr,
		command:     command,
		fingerprint: fingerprint,
		running:     true,
		stdin:       ptmx,
		cmd:         cmd,
		lines:       []string{""},
		stdout:      newStreamBuf(),
		stderr:      newStreamBuf(),
	}
	p.screen = newVTScreen(livePtyCols, livePtyRows, ptmx)

	s.mu.Lock()
	s.panes[p.id] = p
	if corr != "" {
		s.panes[corr] = p
	}
	s.order = append(s.order, p.id)
	s.mu.Unlock()

	drained := make(chan struct{})
	go drainLive(ptmx, func(chunk []byte) {
		p.feedPTY(chunk)
	}, func() { close(drained) })

	go func() {
		waitErr := cmd.Wait()
		code := 0
		if waitErr != nil {
			code = 1
			if ee, ok := waitErr.(*exec.ExitError); ok {
				code = ee.ExitCode()
			}
		}
		_ = ptmx.Close()
		select {
		case <-drained:
		case <-time.After(500 * time.Millisecond):
		}
		p.finishOneshot(code)
	}()
	return p, nil
}

func (p *pane) feedPTY(chunk []byte) {
	if p == nil || len(chunk) == 0 {
		return
	}
	p.mu.Lock()
	p.rawOut = appendCappedRaw(p.rawOut, string(chunk))
	p.mu.Unlock()
	if p.screen != nil {
		p.screen.write(chunk)
	}
	if cleaned := stripRunOutput(string(chunk)); cleaned != "" {
		p.append("stdout", cleaned)
	}
}

func keepOneshotStdout(usedAlt, answered, typed bool, out string) bool {
	if usedAlt {
		return false
	}
	if typed && (answered || strings.Contains(out, "\x1b")) {
		return false
	}
	return true
}

func replayOneshotFinish(usedAlt, answered, typed bool) bool {
	return !usedAlt && !answered && !typed
}

func (p *pane) finishOneshot(code int) {
	if p == nil {
		return
	}
	p.mu.Lock()
	if !p.running {
		p.mu.Unlock()
		return
	}
	raw := p.rawOut
	typed := p.typed
	command := p.command
	screen := p.screen
	p.mu.Unlock()

	usedAlt := screen != nil && screen.altUsed()
	answered := screen != nil && screen.answered()
	out := stripEchoedCommand(stripRunOutput(raw), command)

	if screen != nil {
		screen.resetPrimary()
		if replayOneshotFinish(usedAlt, answered, typed) {
			screen.replay([]byte(rawOutputBeforePrompt(raw)))
		}
	}
	if !keepOneshotStdout(usedAlt, answered, typed, out) {
		out = ""
		if screen != nil {
			out, _, _ = screen.grid()
		}
	}
	p.finishCommand(out, code)
}
