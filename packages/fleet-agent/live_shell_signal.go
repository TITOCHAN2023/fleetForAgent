//go:build !windows

package main

import (
	"io"
	"os"

	"golang.org/x/sys/unix"
)

func foregroundPgid(w io.Writer) int {
	f, ok := w.(*os.File)
	if !ok || f == nil {
		return 0
	}
	pgid, err := unix.IoctlGetInt(int(f.Fd()), unix.TIOCGPGRP)
	if err != nil || pgid <= 1 {
		return 0
	}
	return pgid
}

func signalForeground(w io.Writer, sigint, sigquit bool) {
	if !sigint && !sigquit {
		return
	}
	pgid := foregroundPgid(w)
	if pgid <= 1 {
		return
	}
	if sigint {
		_ = unix.Kill(-pgid, unix.SIGINT)
	}
	if sigquit {
		_ = unix.Kill(-pgid, unix.SIGQUIT)
	}
}
