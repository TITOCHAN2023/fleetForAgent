package backend

import "fmt"

// Open attaches a viewer to sessionName using Requested().
func Open(sessionName string, opts SpawnOpts) (*Handle, error) {
	return OpenType(Requested(), sessionName, opts)
}

// OpenType is Open with an explicit multiplexer (tests).
func OpenType(t Type, sessionName string, opts SpawnOpts) (*Handle, error) {
	if t == "" {
		t = DefaultType
	}
	existing := false
	unknown := false
	if t != TypePTY && sessionName != "" && !opts.Fresh {
		switch ProbeSession(t, sessionName) {
		case ProbeExists:
			existing = true
		case ProbeUnknown:
			unknown = true
		}
	}
	if opts.Fresh && t != TypePTY && sessionName != "" {
		if ProbeSession(t, sessionName) == ProbeExists {
			DestroySession(t, sessionName)
		}
	}
	gate := DecideGate(t, Available(t), existing, unknown)
	if gate.Action == GateRefuse {
		return nil, &GateError{Type: t, Reason: gate.Reason}
	}
	return start(t, sessionName, opts, existing && !opts.Fresh)
}

// ProbeSession is the tri-state mux lookup.
func ProbeSession(t Type, name string) Probe {
	switch t {
	case TypeTmux:
		return probeTmuxSession(name)
	case TypeZellij:
		return probeZellijSession(name)
	default:
		return ProbeMissing
	}
}

// DestroySession kills a named backing session (no-op for pty).
func DestroySession(t Type, name string) {
	switch t {
	case TypeTmux:
		killTmuxSession(name)
	case TypeZellij:
		killZellijSession(name)
	}
}

func start(t Type, sessionName string, opts SpawnOpts, reattach bool) (*Handle, error) {
	switch t {
	case TypePTY:
		return startPTY(opts)
	case TypeTmux:
		return startTmux(sessionName, opts, reattach)
	case TypeZellij:
		return startZellij(sessionName, opts, reattach)
	default:
		return nil, fmt.Errorf("unknown backend %q", t)
	}
}
