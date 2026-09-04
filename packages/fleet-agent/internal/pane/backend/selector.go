package backend

import (
	"os"
	"strings"
	"unicode"
)

// ParseType accepts the botmux names. Unknown values fall back to DefaultType.
func ParseType(s string) Type {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "pty":
		return TypePTY
	case "tmux":
		return TypeTmux
	case "zellij":
		return TypeZellij
	default:
		return DefaultType
	}
}

// Requested is FLEET_BACKEND_TYPE, or tmux when unset.
func Requested() Type {
	return ParseType(os.Getenv(EnvVar))
}

// Available reports a functional probe, not just LookPath.
func Available(t Type) bool {
	switch t {
	case TypePTY:
		return true
	case TypeTmux:
		return tmuxAvailable()
	case TypeZellij:
		return zellijAvailable()
	default:
		return false
	}
}

// DecideGate is botmux decideBackendGate:
//
//   - pty always spawns
//   - an already-running session reattaches even if the capability probe flakes
//   - an indeterminate existence probe also spawns (live pane > timed-out probe)
//   - otherwise the requested mux must be available or we refuse
func DecideGate(requested Type, available, hasExisting, existingUnknown bool) GateDecision {
	if requested == TypePTY {
		return GateDecision{Action: GateSpawn}
	}
	if hasExisting || existingUnknown {
		return GateDecision{Action: GateSpawn}
	}
	if available {
		return GateDecision{Action: GateSpawn}
	}
	return GateDecision{Action: GateRefuse, Reason: string(requested) + " is not usable on this host"}
}

// SessionName is flt-<id>, truncated and sanitized for tmux/zellij.
func SessionName(id string) string {
	return "flt-" + sanitizeName(id, 24)
}

// RunSessionName is a oneshot session: never reused across commands.
func RunSessionName(corr string) string {
	return "flt-run-" + sanitizeName(corr, 20)
}

func sanitizeName(s string, max int) string {
	s = strings.TrimSpace(s)
	if s == "" {
		s = "anon"
	}
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case unicode.IsLetter(r), unicode.IsDigit(r), r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		out = "anon"
	}
	if max > 0 && len(out) > max {
		out = out[:max]
	}
	return out
}
