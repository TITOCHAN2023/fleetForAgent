//go:build !windows

package main

import (
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
)

// Internal double-fork stage. Not a restarter protocol; only --daemon uses it.
const daemonStageEnv = "_FLEET_DAEMON_STAGE"

const (
	daemonStageLeader = "1"
	daemonStageRun    = "2"
)

func wantsDaemonize(args []string) bool {
	return len(args) > 0 && (args[0] == "--daemon" || args[0] == "daemon")
}

// maybeDaemonize is the APUE daemonize: fork, setsid, fork again, then
// reopen stdin/stdout/stderr so no fd refers to the caller's TTY/PTY.
// The grandchild's PPID is 1. No-args (the .app / tray) is left attached.
func maybeDaemonize() {
	if !wantsDaemonize(os.Args[1:]) {
		return
	}
	switch os.Getenv(daemonStageEnv) {
	case daemonStageRun:
		_ = os.Unsetenv(daemonStageEnv)
		_ = os.Chdir("/")
		syscall.Umask(0)
		signal.Ignore(syscall.SIGHUP)
		reopenStdio()
		return
	case daemonStageLeader:
		signal.Ignore(syscall.SIGHUP)
		if err := spawnDaemonChild(daemonStageRun, false); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	default:
		if err := spawnDaemonChild(daemonStageLeader, true); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
}

func spawnDaemonChild(stage string, setsid bool) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Dir = "/"
	cmd.Env = withDaemonStage(os.Environ(), stage)
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer null.Close()
	cmd.Stdin = null
	if logf, err := openDaemonLog(); err == nil {
		defer logf.Close()
		cmd.Stdout = logf
		cmd.Stderr = logf
	} else {
		cmd.Stdout = null
		cmd.Stderr = null
	}
	if setsid {
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func withDaemonStage(env []string, stage string) []string {
	prefix := daemonStageEnv + "="
	out := make([]string, 0, len(env)+1)
	for _, e := range env {
		if len(e) >= len(prefix) && e[:len(prefix)] == prefix {
			continue
		}
		out = append(out, e)
	}
	return append(out, prefix+stage)
}

func openDaemonLog() (*os.File, error) {
	dir := fleetHome()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return os.OpenFile(filepath.Join(dir, "daemon.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
}

func reopenStdio() {
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return
	}
	_ = unix.Dup2(int(null.Fd()), 0)
	out := null
	if logf, err := openDaemonLog(); err == nil {
		out = logf
	}
	_ = unix.Dup2(int(out.Fd()), 1)
	_ = unix.Dup2(int(out.Fd()), 2)
	os.Stdin = os.NewFile(0, os.DevNull)
	os.Stdout = os.NewFile(1, "daemon-stdout")
	os.Stderr = os.NewFile(2, "daemon-stderr")
}
