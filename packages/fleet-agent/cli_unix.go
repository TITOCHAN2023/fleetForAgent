//go:build !windows

package main

import "syscall"

func initCLIStdio() {}

func detachAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}
