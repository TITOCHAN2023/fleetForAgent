package backend

import "strings"

func dropMuxClientEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, e := range env {
		switch {
		case strings.HasPrefix(e, "TMUX="),
			strings.HasPrefix(e, "TMUX_PANE="),
			strings.HasPrefix(e, "ZELLIJ="),
			strings.HasPrefix(e, "ZELLIJ_SESSION_NAME="),
			strings.HasPrefix(e, "ZELLIJ_PANE_ID="):
			continue
		}
		out = append(out, e)
	}
	return out
}

func isServerLevelMuxError(stderr string) bool {
	s := strings.ToLower(stderr)
	return strings.Contains(s, "error connecting to") ||
		strings.Contains(s, "lost server") ||
		strings.Contains(s, "server exited unexpectedly")
}
