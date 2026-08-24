//go:build !darwin && !windows && !linux

package tray

import "os"

const Enabled = false

func Run(Controller) { select {} }

func Update(Snapshot) {}

func RequestQuit() { os.Exit(0) }
