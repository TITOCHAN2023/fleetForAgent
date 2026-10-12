//go:build windows

package backend

func zellijAvailable() bool { return false }

func probeZellijSession(name string) Probe { return ProbeMissing }

func startZellij(session string, opts SpawnOpts, reattach bool) (*Handle, error) {
	return nil, &GateError{Type: TypeZellij, Reason: "zellij is POSIX-only"}
}
