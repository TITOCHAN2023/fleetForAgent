// Package backend is the live-session multiplexer, copied from botmux's
// SessionBackend: pty (emergency), tmux (default), zellij (opt-in).
//
// Architecture is pty-under-mux. The agent still talks to a PTY master; the
// child is `tmux attach` / `zellij attach` (or a raw shell). kill of the
// viewer detaches. Destroy tears down the backing session (explicit close).
// A crashed agent therefore leaves tmux/zellij sessions running so the next
// process can reattach — PTY sessions cannot.
package backend

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
)

// Type is the multiplexer. Names match botmux BACKEND_TYPE.
type Type string

const (
	TypePTY    Type = "pty"
	TypeTmux   Type = "tmux"
	TypeZellij Type = "zellij"
)

// DefaultType is tmux, same as botmux. PTY is explicit opt-in only.
const DefaultType = TypeTmux

// EnvVar is the process-wide selector (botmux: BACKEND_TYPE).
const EnvVar = "FLEET_BACKEND_TYPE"

// Probe is the tri-state existence check. A timeout/connect error is
// Unknown, never Missing — treating Unknown as Missing is how botmux once
// mass-killed live sessions under load.
type Probe string

const (
	ProbeExists  Probe = "exists"
	ProbeMissing Probe = "missing"
	ProbeUnknown Probe = "unknown"
)

// SpawnOpts is the child command plus PTY size.
type SpawnOpts struct {
	Bin  string
	Args []string
	Cwd  string
	Env  []string
	Cols uint16
	Rows uint16
	// Fresh never reattaches. Oneshot runs use this so a leftover mux
	// session cannot swallow a new command.
	Fresh bool
}

// Handle is one attached viewer plus the backing session it may own.
type Handle struct {
	mu          sync.Mutex
	Type        Type
	SessionName string
	Persistent  bool
	Reattach    bool
	File        *os.File
	Cmd         *exec.Cmd

	owns    bool
	closed  bool
	destroy func()
}

// Detach closes the PTY viewer. A persistent session keeps running.
func (h *Handle) Detach() {
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closeViewerLocked()
}

// Destroy detaches and, when this handle owns the session, kills it.
func (h *Handle) Destroy() {
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closeViewerLocked()
	if h.owns && h.destroy != nil {
		h.destroy()
		h.destroy = nil
	}
}

func (h *Handle) closeViewerLocked() {
	if h.closed {
		return
	}
	h.closed = true
	if h.File != nil {
		_ = h.File.Close()
	}
	if h.Cmd != nil && h.Cmd.Process != nil {
		_ = h.Cmd.Process.Kill()
	}
}

// GateDecision is spawn vs refuse. Persistent backends never silent-fallback
// to PTY (botmux PTY 退役).
type GateDecision struct {
	Action GateAction
	Reason string
}

// GateAction is the selector result.
type GateAction string

const (
	GateSpawn  GateAction = "spawn"
	GateRefuse GateAction = "gate"
)

// GateError is the user-facing hard gate when tmux/zellij is missing.
type GateError struct {
	Type   Type
	Reason string
}

func (e *GateError) Error() string {
	return strings.TrimSpace(e.Type.String() + " backend unavailable: " + e.Reason)
}

func (t Type) String() string {
	if t == "" {
		return string(DefaultType)
	}
	return string(t)
}

// UserMessage is the install hint botmux posts when the gate fires.
func (e *GateError) UserMessage() string {
	hint := fmt.Sprintf("install %s and retry", e.Type)
	switch e.Type {
	case TypeTmux:
		hint = "macOS: brew install tmux  |  Debian/Ubuntu: sudo apt-get install -y tmux"
	case TypeZellij:
		hint = "macOS: brew install zellij  |  Linux: see https://zellij.dev/documentation/installation"
	}
	return strings.Join([]string{
		fmt.Sprintf("this host cannot start a %s session.", e.Type),
		"reason: " + e.Reason,
		hint,
		"set " + EnvVar + "=pty for the emergency PTY backend (does not survive agent restart).",
	}, "\n")
}
