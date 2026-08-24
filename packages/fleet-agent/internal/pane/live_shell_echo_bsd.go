//go:build darwin || freebsd || netbsd || openbsd

package pane

import "golang.org/x/sys/unix"

const (
	ioctlReadTermios  = unix.TIOCGETA
	ioctlWriteTermios = unix.TIOCSETA // TCSANOW on BSD/Darwin
)
