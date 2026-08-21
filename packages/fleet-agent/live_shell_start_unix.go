//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/creack/pty"
)

// startLiveShell opens an interactive login shell on a real PTY (ssh-mcp-sessions
// conn.shell). TERM is xterm-256color so tty/isatty and Codex doctor see a
// real terminal. ECHO is cleared on the PTY master (not via slave stty).
// stderr stays a pipe so command stderr is still split. Completion is the
// unique PS1, not a printf on stdin.
func startLiveShell() (*liveShell, error) {
	cmd := exec.Command(pickShell(), "-il")
	if home := userHome(); home != "" {
		cmd.Dir = home
	}
	env := os.Environ()
	out := make([]string, 0, len(env)+1)
	for _, e := range env {
		if strings.HasPrefix(e, "TERM=") {
			continue
		}
		out = append(out, e)
	}
	cmd.Env = append(out, "TERM=xterm-256color")

	errR, errW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = errW

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 40, Cols: 120})
	if err != nil {
		_ = errR.Close()
		_ = errW.Close()
		return nil, fmt.Errorf("pty start: %w", err)
	}
	_ = errW.Close()
	disableMasterEcho(ptmx)

	ls := &liveShell{cmd: cmd, stdin: ptmx, lastUsed: time.Now(), idleFor: shellIdleFor}
	readyCh := make(chan struct{}, 1)
	beginLiveIO(ls, ptmx, errR, readyCh)
	go func() {
		_ = cmd.Wait()
		_ = ptmx.Close()
		_ = errR.Close()
		ls.markExit()
	}()
	waitLiveReady(ls, ptmx, readyCh)
	return ls, nil
}
