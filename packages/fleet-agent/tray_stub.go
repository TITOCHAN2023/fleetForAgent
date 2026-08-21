//go:build !darwin && !windows && !linux

package main

import "os"

const trayEnabled = false

func runTray(*Agent) { select {} }

func updateTray(State) {}

func requestQuit() { os.Exit(0) }
