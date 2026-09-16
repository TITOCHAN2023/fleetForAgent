//go:build !windows

package backend

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/creack/pty"
)

// Each Fleet session has its own Herdr server and configuration. Never connect
// to the user's default Herdr socket or take over another terminal controller.
func herdrDir(name string) string {
	home := os.Getenv("FLEET_HOME")
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	sum := sha256.Sum256([]byte(home + "\x00" + name))
	return filepath.Join(os.TempDir(), "fleet-herdr-"+strconv.Itoa(os.Getuid()), fmt.Sprintf("%x", sum[:12]))
}

func herdrEnv(name string, env []string) []string {
	if env == nil {
		env = os.Environ()
	}
	out := []string{}
	for _, entry := range dropMuxClientEnv(env) {
		key, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(key, "HERDR_") || key == "XDG_CONFIG_HOME" || key == "XDG_STATE_HOME" {
			continue
		}
		out = append(out, entry)
	}
	dir := herdrDir(name)
	return append(out, "XDG_CONFIG_HOME="+dir, "XDG_STATE_HOME="+dir, "HERDR_CONFIG_PATH="+filepath.Join(dir, "herdr", "config.toml"))
}

func herdrCall(name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "herdr", args...)
	cmd.Env = herdrEnv(name, nil)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("herdr %s: %w", args[0], err)
	}
	return out, nil
}

func herdrAvailable() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "herdr", "--version").Run() == nil
}

func probeHerdrSession(name string) Probe {
	socket := filepath.Join(herdrDir(name), "herdr", "herdr.sock")
	if _, err := os.Lstat(socket); os.IsNotExist(err) {
		return ProbeMissing
	}
	if _, err := herdrCall(name, "pane", "list"); err != nil {
		return ProbeUnknown
	}
	return ProbeExists
}

func killHerdrSession(name string) {
	if _, err := herdrCall(name, "server", "stop"); err == nil && probeHerdrSession(name) == ProbeMissing {
		// Explicit close must not restore the old layout and spawn a second shell
		// when this name is opened again.
		_ = os.RemoveAll(herdrDir(name))
	}
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }

// Refuse symlinks and directories another Unix user could write.
func privateHerdrDir(path string) error {
	if err := os.Mkdir(path, 0700); err != nil && !os.IsExist(err) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || info.Mode().Perm() != 0700 || !ok || st.Uid != uint32(os.Getuid()) {
		return fmt.Errorf("unsafe Herdr runtime directory: %s", path)
	}
	return nil
}

func lockHerdr(name string) (*os.File, error) {
	dir := herdrDir(name)
	if err := privateHerdrDir(filepath.Dir(dir)); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(dir+".lock", os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("Herdr session is being opened; retry: %w", err)
	}
	return f, nil
}

func prepareHerdr(name string, opts SpawnOpts) error {
	dir := herdrDir(name)
	for _, path := range []string{filepath.Dir(dir), dir, filepath.Join(dir, "herdr")} {
		if err := privateHerdrDir(path); err != nil {
			return err
		}
	}
	script := "#!/bin/sh\n"
	// The server needs private XDG paths; the actual command keeps its original
	// environment. No credentials are put in argv or written into configuration.
	for _, key := range []string{"XDG_CONFIG_HOME", "XDG_STATE_HOME", "HERDR_CONFIG_PATH"} {
		script += "unset " + key + "\n"
		for _, entry := range opts.Env {
			k, v, _ := strings.Cut(entry, "=")
			if k == key {
				script += "export " + key + "=" + shellQuote(v) + "\n"
			}
		}
	}
	script += "exec " + shellQuote(opts.Bin)
	for _, arg := range opts.Args {
		script += " " + shellQuote(arg)
	}
	script += "\n"
	shell := filepath.Join(dir, "shell")
	if err := os.WriteFile(shell, []byte(script), 0700); err != nil {
		return err
	}
	cfg := "onboarding = false\n[terminal]\ndefault_shell = " + strconv.Quote(shell) + "\nshell_mode = \"non_login\"\nnew_cwd = \"current\"\n[update]\nversion_check = false\nmanifest_check = false\n"
	return os.WriteFile(filepath.Join(dir, "herdr", "config.toml"), []byte(cfg), 0600)
}

func herdrTerminal(name string) (string, error) {
	out, err := herdrCall(name, "pane", "list")
	if err != nil {
		return "", err
	}
	var reply struct {
		Result struct {
			Panes []struct {
				TerminalID string `json:"terminal_id"`
			} `json:"panes"`
		} `json:"result"`
	}
	if err := json.Unmarshal(out, &reply); err != nil {
		return "", err
	}
	if len(reply.Result.Panes) != 1 || reply.Result.Panes[0].TerminalID == "" {
		return "", fmt.Errorf("Herdr Fleet session must contain exactly one terminal")
	}
	return reply.Result.Panes[0].TerminalID, nil
}

func startHerdr(name string, opts SpawnOpts, reattach bool) (*Handle, error) {
	if name == "" {
		return nil, fmt.Errorf("Herdr requires a session name")
	}
	lock, err := lockHerdr(name)
	if err != nil {
		return nil, err
	}
	defer lock.Close()
	if !reattach {
		if probeHerdrSession(name) != ProbeMissing {
			return nil, fmt.Errorf("Herdr session state is indeterminate; refusing to replace it")
		}
		if err := prepareHerdr(name, opts); err != nil {
			return nil, err
		}
		server := exec.Command("herdr", "server")
		server.Env = herdrEnv(name, opts.Env)
		server.Dir = opts.Cwd
		server.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		if err := server.Start(); err != nil {
			return nil, err
		}
		go func() { _ = server.Wait() }()
		ready := false
		for i := 0; i < 50; i++ {
			if probeHerdrSession(name) == ProbeExists {
				ready = true
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
		if !ready {
			_ = server.Process.Kill()
			return nil, fmt.Errorf("Herdr server did not become ready")
		}
		if _, err := herdrCall(name, "workspace", "create", "--cwd", opts.Cwd, "--label", name, "--no-focus"); err != nil {
			killHerdrSession(name)
			return nil, err
		}
	}
	terminal, err := herdrTerminal(name)
	if err != nil {
		if !reattach {
			killHerdrSession(name)
		}
		return nil, err
	}
	cmd := exec.Command("herdr", "terminal", "attach", terminal)
	cmd.Env = herdrEnv(name, opts.Env)
	cmd.Dir = opts.Cwd
	file, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: opts.Rows, Cols: opts.Cols})
	if err != nil {
		if !reattach {
			killHerdrSession(name)
		}
		return nil, err
	}
	return &Handle{Type: TypeHerdr, SessionName: name, Persistent: true, Reattach: reattach, File: file, Cmd: cmd, owns: true, destroy: func() { killHerdrSession(name) }}, nil
}
