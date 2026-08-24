//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

func spawnSuccessor(exe string, args, env []string) error {
	cmd := exec.Command(exe, args...)
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
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
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
