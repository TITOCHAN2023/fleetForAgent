//go:build !windows && !linux && !darwin && !freebsd && !netbsd && !openbsd

package main

import "golang.org/x/sys/unix"

const (
	ioctlReadTermios  = unix.TCGETS
	ioctlWriteTermios = unix.TCSETS
)
