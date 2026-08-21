//go:build windows

package main

import "io"

func signalForeground(w io.Writer, sigint, sigquit bool) {}
