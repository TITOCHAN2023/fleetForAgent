//go:build !windows

package backend

import (
	"fmt"
	"os/exec"

	"github.com/creack/pty"
)

func startPTY(opts SpawnOpts) (*Handle, error) {
	cmd := exec.Command(opts.Bin, opts.Args...)
	cmd.Dir = opts.Cwd
	cmd.Env = opts.Env
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: opts.Rows, Cols: opts.Cols})
	if err != nil {
		return nil, fmt.Errorf("pty start: %w", err)
	}
	return &Handle{
		Type: TypePTY,
		File: ptmx,
		Cmd:  cmd,
		owns: true,
		destroy: func() {
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
		},
	}, nil
}
