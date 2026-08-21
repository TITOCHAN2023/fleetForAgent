//go:build windows

package main

func wantsDaemonize(args []string) bool {
	return len(args) > 0 && (args[0] == "--daemon" || args[0] == "daemon")
}

func maybeDaemonize() {}
