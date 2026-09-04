//go:build !windows

package backend

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/creack/pty"
)

const zellijConfigKDL = `// fleet-generated — do not edit
show_startup_tips false
pane_frames false
default_mode "locked"
keybinds clear-defaults=true {
}
`

func zellijAvailable() bool {
	if _, err := exec.LookPath("zellij"); err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "zellij", "--version").Run() == nil
}

func probeZellijSession(name string) Probe {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "zellij", "list-sessions", "--no-formatting")
	cmd.Env = dropMuxClientEnv(os.Environ())
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if ctx.Err() != nil {
		return ProbeUnknown
	}
	names := liveZellijNames(stdout.String())
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok && ee.ExitCode() == 1 {
			if len(names) > 0 {
				return zellijHasNameFrom(names, name)
			}
			if strings.Contains(strings.ToLower(stderr.String()), "no active zellij sessions") {
				return ProbeMissing
			}
		}
		return ProbeUnknown
	}
	return zellijHasNameFrom(names, name)
}

func liveZellijNames(raw string) []string {
	var names []string
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.Contains(strings.ToUpper(line), "EXITED") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) > 0 {
			names = append(names, fields[0])
		}
	}
	return names
}

func zellijHasNameFrom(names []string, name string) Probe {
	for _, n := range names {
		if n == name {
			return ProbeExists
		}
	}
	return ProbeMissing
}

func killZellijSession(name string) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "zellij", "delete-session", name, "-f")
	cmd.Env = dropMuxClientEnv(os.Environ())
	_ = cmd.Run()
}

func kdlString(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return `"` + s + `"`
}

func zellijLayout(opts SpawnOpts) string {
	pane := "    pane command=" + kdlString(opts.Bin) + " close_on_exit=true"
	if len(opts.Args) == 0 {
		return "layout {\n" + pane + "\n}"
	}
	args := make([]string, 0, len(opts.Args))
	for _, a := range opts.Args {
		args = append(args, kdlString(a))
	}
	return strings.Join([]string{
		"layout {",
		pane + " {",
		"        args " + strings.Join(args, " "),
		"    }",
		"}",
	}, "\n")
}

func startZellij(session string, opts SpawnOpts, reattach bool) (*Handle, error) {
	dir, err := os.MkdirTemp("", "flt-zellij-")
	if err != nil {
		return nil, err
	}
	cfg := filepath.Join(dir, "config.kdl")
	layout := filepath.Join(dir, "layout.kdl")
	if err := os.WriteFile(cfg, []byte(zellijConfigKDL), 0o600); err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	var args []string
	if reattach {
		args = []string{"--config", cfg, "attach", session}
	} else {
		if err := os.WriteFile(layout, []byte(zellijLayout(opts)), 0o600); err != nil {
			_ = os.RemoveAll(dir)
			return nil, err
		}
		args = []string{"--config", cfg, "--session", session, "--new-session-with-layout", layout}
	}
	cmd := exec.Command("zellij", args...)
	cmd.Dir = opts.Cwd
	cmd.Env = dropMuxClientEnv(opts.Env)
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: opts.Rows, Cols: opts.Cols})
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, fmt.Errorf("zellij pty start: %w", err)
	}
	name := session
	return &Handle{
		Type:        TypeZellij,
		SessionName: name,
		Persistent:  true,
		Reattach:    reattach,
		File:        ptmx,
		Cmd:         cmd,
		owns:        true,
		destroy: func() {
			killZellijSession(name)
			_ = os.RemoveAll(dir)
		},
	}, nil
}
