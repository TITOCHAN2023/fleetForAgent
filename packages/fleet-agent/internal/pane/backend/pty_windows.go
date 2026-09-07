//go:build windows

package backend

import "fmt"

func startPTY(opts SpawnOpts) (*Handle, error) {
	return nil, fmt.Errorf("pty backend is POSIX-only")
}
