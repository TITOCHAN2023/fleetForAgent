//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"time"

	"github.com/creack/pty"
)

// startLiveShell opens an interactive login shell on a real PTY (ssh-mcp-sessions
// conn.shell). stty -echo then actually applies, so typed commands and the
// marker are not echoed. stderr stays a pipe so command stderr is still split.
func startLiveShell() (*liveShell, error) {
	cmd := exec.Command(pickShell(), "-il")
	if home := userHome(); home != "" {
		cmd.Dir = home
	}
	if os.Getenv("TERM") == "" {
		cmd.Env = append(os.Environ(), "TERM=xterm")
	}

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
