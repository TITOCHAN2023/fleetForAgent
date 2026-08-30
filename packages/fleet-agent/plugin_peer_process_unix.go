//go:build !windows

package main

import (
	"os/exec"
	"sync"
	"syscall"
)

type unixPluginProcessTree struct {
	cmd       *exec.Cmd
	closeOnce sync.Once
}

func startPluginProcess(cmd *exec.Cmd) (pluginProcessTree, error) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &unixPluginProcessTree{cmd: cmd}, nil
}

func (p *unixPluginProcessTree) terminate(force bool) {
	if p == nil || p.cmd == nil || p.cmd.Process == nil {
		return
	}
	if force {
		p.closeTree()
		return
	}
	p.signal(syscall.SIGTERM)
}

func (p *unixPluginProcessTree) signal(signal syscall.Signal) {
	if err := syscall.Kill(-p.cmd.Process.Pid, signal); err != nil {
		_ = p.cmd.Process.Signal(signal)
	}
}

func (p *unixPluginProcessTree) closeTree() {
	p.closeOnce.Do(func() { p.signal(syscall.SIGKILL) })
}

func (p *unixPluginProcessTree) close() {
	if p == nil || p.cmd == nil || p.cmd.Process == nil {
		return
	}
	p.closeTree()
}
