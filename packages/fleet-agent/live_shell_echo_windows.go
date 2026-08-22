//go:build windows

package main

import "os"

func disableMasterEcho(f *os.File) {}

func killLiveProcess(p *os.Process) {
	if p != nil {
		_ = p.Kill()
	}
}
