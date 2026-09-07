//go:build !windows

package backend

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"time"

	"github.com/creack/pty"
)

func tmuxAvailable() bool {
	if _, err := exec.LookPath("tmux"); err != nil {
		return false
	}
	sock := "fleet-probe-" + strconv.Itoa(os.Getpid())
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "tmux", "-L", sock, "new-session", "-d", "-s", "probe", "true")
	cmd.Env = dropMuxClientEnv(os.Environ())
	if err := cmd.Run(); err != nil {
		return false
	}
	kill := exec.Command("tmux", "-L", sock, "kill-server")
	kill.Env = dropMuxClientEnv(os.Environ())
	_ = kill.Run()
	return true
}

func probeTmuxSession(name string) Probe {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "tmux", "has-session", "-t", name)
	cmd.Env = dropMuxClientEnv(os.Environ())
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		return ProbeExists
	}
	if ctx.Err() != nil {
		return ProbeUnknown
	}
	if ee, ok := err.(*exec.ExitError); ok && ee.ExitCode() > 0 && ee.Exited() {
		if isServerLevelMuxError(stderr.String()) {
			return ProbeUnknown
		}
		return ProbeMissing
	}
	return ProbeUnknown
}

func killTmuxSession(name string) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "tmux", "kill-session", "-t", name)
	cmd.Env = dropMuxClientEnv(os.Environ())
	_ = cmd.Run()
}

func startTmux(session string, opts SpawnOpts, reattach bool) (*Handle, error) {
	env := dropMuxClientEnv(opts.Env)
	if !reattach {
		// Detached create does not need a TTY. The viewer is a separate
		// `attach-session` under creack/pty (botmux: pty-under-tmux).
		args := []string{
			"new-session", "-d",
			"-s", session,
			"-x", strconv.Itoa(int(opts.Cols)),
			"-y", strconv.Itoa(int(opts.Rows)),
			"--",
			opts.Bin,
		}
		args = append(args, opts.Args...)
		create := exec.Command("tmux", args...)
		create.Dir = opts.Cwd
		create.Env = env
		var stderr bytes.Buffer
		create.Stderr = &stderr
		if err := create.Run(); err != nil {
			return nil, fmt.Errorf("tmux new-session: %w (%s)", err, bytes.TrimSpace(stderr.Bytes()))
		}
	}
	cmd := exec.Command("tmux", "attach-session", "-t", session)
	cmd.Dir = opts.Cwd
	cmd.Env = env
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: opts.Rows, Cols: opts.Cols})
	if err != nil {
		if !reattach {
			killTmuxSession(session)
		}
		return nil, fmt.Errorf("tmux attach: %w", err)
	}
	name := session
	return &Handle{
		Type:        TypeTmux,
		SessionName: name,
		Persistent:  true,
		Reattach:    reattach,
		File:        ptmx,
		Cmd:         cmd,
		owns:        true,
		destroy:     func() { killTmuxSession(name) },
	}, nil
}
