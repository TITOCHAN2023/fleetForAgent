//go:build !windows

package pane

import (
	"fmt"
	"time"

	"github.com/TITOCHAN2023/fleetForAgent/internal/pane/backend"
)

func liveShellEnv() []string {
	return runCommandEnv()
}

// startLiveShell opens an interactive login shell on the selected backend
// (tmux default, zellij opt-in, pty emergency). Stdin/stdout/stderr share
// one PTY master. ECHO is cleared on the master. Completion is PS1.
func startLiveShell(fp string) (*liveShell, error) {
	opts := backend.SpawnOpts{
		Bin:  pickShell(),
		Args: []string{"-il"},
		Cwd:  userHome(),
		Env:  liveShellEnv(),
		Cols: livePtyCols,
		Rows: livePtyRows,
	}
	h, err := backend.Open(backend.SessionName(fp), opts)
	if err != nil {
		return nil, err
	}
	if h.File == nil {
		h.Destroy()
		return nil, fmt.Errorf("%s backend returned no pty", h.Type)
	}

	disableMasterEcho(h.File)

	ls := &liveShell{
		cmd:      h.Cmd,
		handle:   h,
		stdin:    h.File,
		lastUsed: time.Now(),
		idleFor:  shellIdleFor,
	}
	ls.screen = newVTScreen(livePtyCols, livePtyRows, ls)
	readyCh := make(chan struct{}, 1)
	beginLiveIO(ls, h.File, readyCh)
	go func() {
		if h.Cmd != nil {
			_ = h.Cmd.Wait()
		}
		_ = h.File.Close()
		ls.markExit()
	}()
	if h.Reattach {
		// Surviving mux session already has PS1 from the previous agent.
		ls.mu.Lock()
		ls.ready = true
		ls.rawOut = ""
		ls.rawErr = ""
		ls.mu.Unlock()
		if f := h.File; f != nil {
			disableMasterEcho(f)
		}
		return ls, nil
	}
	waitLiveReady(ls, h.File, readyCh)
	return ls, nil
}
