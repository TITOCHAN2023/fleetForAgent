//go:build windows

package main

import "fmt"

func startLiveShell() (*liveShell, error) {
	return nil, fmt.Errorf("live shell is POSIX-only")
}
