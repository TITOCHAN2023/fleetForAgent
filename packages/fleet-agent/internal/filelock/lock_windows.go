//go:build windows

package filelock

import (
	"errors"
	"golang.org/x/sys/windows"
	"os"
)

func Acquire(path string) (func(), error) {
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return nil, errors.New("lock must be a regular file")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	overlapped := &windows.Overlapped{}
	flags := uint32(windows.LOCKFILE_EXCLUSIVE_LOCK | windows.LOCKFILE_FAIL_IMMEDIATELY)
	if err = windows.LockFileEx(windows.Handle(f.Fd()), flags, 0, 1, 0, overlapped); err != nil {
		f.Close()
		return nil, errors.New("file is locked by another process")
	}
	return func() { windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, overlapped); f.Close() }, nil
}
