//go:build windows

package backend

func tmuxAvailable() bool { return false }

func probeTmuxSession(name string) Probe { return ProbeMissing }

func startTmux(session string, opts SpawnOpts, reattach bool) (*Handle, error) {
	return nil, &GateError{Type: TypeTmux, Reason: "tmux is POSIX-only"}
}
