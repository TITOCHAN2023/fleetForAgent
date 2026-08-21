//go:build windows

package main

import (
	"os"
	"syscall"
)

func initCLIStdio() {
	k32 := syscall.NewLazyDLL("kernel32.dll")
	attach := k32.NewProc("AttachConsole")
	const attachParent = ^uintptr(0) // ATTACH_PARENT_PROCESS
	r, _, _ := attach.Call(attachParent)
	if r == 0 {
		return
	}
	out, _ := syscall.GetStdHandle(syscall.STD_OUTPUT_HANDLE)
	errh, _ := syscall.GetStdHandle(syscall.STD_ERROR_HANDLE)
	os.Stdout = os.NewFile(uintptr(out), "stdout")
	os.Stderr = os.NewFile(uintptr(errh), "stderr")
}

func detachAttr() *syscall.SysProcAttr {
	const detached = 0x00000008
	const noWindow = 0x08000000
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: detached | noWindow}
}
