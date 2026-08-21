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

func liveShellEnv() []string {
	out := make([]string, 0, len(os.Environ())+1)
	for _, e := range os.Environ() {
		if strings.HasPrefix(e, "TERM=") || strings.HasPrefix(e, "NO_COLOR=") || strings.HasPrefix(e, "FORCE_COLOR=") {
			continue
		}
		out = append(out, e)
	}
	return append(out, "TERM=xterm-256color")
}

// startLiveShell opens an interactive login shell on a real PTY. Stdin,
// stdout, and stderr stay nil so pty.Start attaches the same pts to all
// three (one screen). ECHO is cleared on the master. Completion is PS1.
func startLiveShell() (*liveShell, error) {
	cmd := exec.Command(pickShell(), "-il")
	if home := userHome(); home != "" {
		cmd.Dir = home
	}
	cmd.Env = liveShellEnv()

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 40, Cols: 120})
	if err != nil {
		return nil, fmt.Errorf("pty start: %w", err)
	}
	disableMasterEcho(ptmx)

	ls := &liveShell{cmd: cmd, stdin: ptmx, lastUsed: time.Now(), idleFor: shellIdleFor}
	readyCh := make(chan struct{}, 1)
	beginLiveIO(ls, ptmx, readyCh)
	go func() {
		_ = cmd.Wait()
		_ = ptmx.Close()
		ls.markExit()
	}()
	waitLiveReady(ls, ptmx, readyCh)
	return ls, nil
}
