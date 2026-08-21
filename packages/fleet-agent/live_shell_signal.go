//go:build !windows

package main

import (
	"io"
	"os"

	"golang.org/x/sys/unix"
)

func signalForeground(w io.Writer, sigint, sigquit bool) {
	if !sigint && !sigquit {
		return
	}
	f, ok := w.(*os.File)
	if !ok || f == nil {
		return
	}
	pgid, err := unix.IoctlGetInt(int(f.Fd()), unix.TIOCGPGRP)
	if err != nil || pgid <= 1 {
		return
	}
	if sigint {
		_ = unix.Kill(-pgid, unix.SIGINT)
	}
	if sigquit {
		_ = unix.Kill(-pgid, unix.SIGQUIT)
	}
}
