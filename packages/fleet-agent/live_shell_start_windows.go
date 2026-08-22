//go:build windows

package main

import "fmt"

// startLiveShell is not used on Windows: supervisor.spawn uses spawnOneshot
// (cmd /C). This stub exists so the package compiles. Interactive login PTY
// is POSIX-only.
func startLiveShell() (*liveShell, error) {
	return nil, fmt.Errorf("live shell is POSIX-only; Windows uses cmd /C oneshot")
}
