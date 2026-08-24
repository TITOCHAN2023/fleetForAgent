//go:build windows

package pane

import "io"

func foregroundPgid(w io.Writer) int { return 0 }

func signalForeground(w io.Writer, sigint, sigquit bool) {}
