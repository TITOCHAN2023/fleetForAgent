//go:build !windows

package pane

import (
	"os"

	"golang.org/x/sys/unix"
)

// disableMasterEcho turns ECHO off on the PTY master. This is not a slave
// command, so it cannot become a SIGTTOU-stopped job the way `stty -echo` does.
func disableMasterEcho(f *os.File) {
	if f == nil {
		return
	}
	fd := int(f.Fd())
	tio, err := unix.IoctlGetTermios(fd, ioctlReadTermios)
	if err != nil {
		return
	}
	tio.Lflag &^= unix.ECHO
	_ = unix.IoctlSetTermios(fd, ioctlWriteTermios, tio)
}

func killLiveProcess(p *os.Process) {
	if p == nil {
		return
	}
	_ = unix.Kill(-p.Pid, unix.SIGKILL)
	_ = p.Kill()
}
