// Package hostaudit describes observations, not command completion or policy.
// Collectors own only their observation lifetime; they never own host workloads.
package hostaudit

import (
	"fmt"
	"os/exec"
	"sync"
	"time"
)

type ProcessIdentity struct {
	BootID  string `json:"boot_id"`
	PID     int    `json:"pid"`
	StartID string `json:"start_id"`
}

func (p ProcessIdentity) Valid() bool { return p.PID > 0 && p.BootID != "" && p.StartID != "" }

type Capabilities struct {
	Backend, State, Scope                                       string
	ProcessLifecycle, FilePathOperations, FDIO, NetworkAttempts bool
	NetworkFlows, DesktopCausality                              bool
}
type Event struct {
	Kind, Phase, Corr, PaneID, ParentCommandCorr, Operation, Evidence, Reason string
	Process, Root, Parent                                                     ProcessIdentity
	Details                                                                   map[string]any
}

// Flat metadata survives the journal's existing SafeDetails contract.
func (e Event) Metadata() map[string]any {
	m := map[string]any{"scope": "ordinary_host", "evidence": e.Evidence}
	for k, v := range e.Details {
		m[k] = v
	}
	for k, v := range map[string]string{"pane_id": e.PaneID, "parent_command_corr": e.ParentCommandCorr, "operation": e.Operation, "reason": e.Reason} {
		if v != "" {
			m[k] = v
		}
	}
	for label, p := range map[string]ProcessIdentity{"process": e.Process, "root": e.Root, "parent": e.Parent} {
		if p.PID > 0 {
			m[label+"_pid"] = p.PID
		}
		if p.BootID != "" {
			m[label+"_boot_id"] = p.BootID
		}
		if p.StartID != "" {
			m[label+"_start_id"] = p.StartID
		}
	}
	return m
}

type Sink func(Event) error
type Options struct {
	Enabled   bool
	MaxEvents int
	Lease     time.Duration
}

func DefaultOptions(enabled bool) Options {
	return Options{Enabled: enabled, MaxEvents: 100000, Lease: 30 * time.Minute}
}

type Health struct {
	Corr        string `json:"corr"`
	State       string `json:"state"`
	Reason      string `json:"reason"`
	Persistence string `json:"persistence"`
	Detach      string `json:"detach,omitempty"`
}

type Session interface {
	Bind(pid int)
	RootCompleted(code int)
	Close(reason string)
	Done() <-chan struct{}
	RootIdentity() ProcessIdentity
	Health() Health
}

// Launch is called before Start. An unavailable backend returns the original
// command and a gap session. A launch failure is never retried.
func Prepare(cmd *exec.Cmd, corr, paneID string, opts Options, sink Sink) (*exec.Cmd, Session, error) {
	if sink == nil {
		sink = func(Event) error { return nil }
	}
	if opts.MaxEvents <= 0 {
		opts.MaxEvents = 100000
	}
	if opts.Lease <= 0 {
		opts.Lease = 30 * time.Minute
	}
	if !opts.Enabled {
		return cmd, gap(corr, paneID, "not_enabled", sink), nil
	}
	return prepare(cmd, corr, paneID, opts, sink)
}

type gapSession struct {
	corr, paneID string
	sink         Sink
	delivery     *delivery
	reason       string
	root         ProcessIdentity
	done         chan struct{}
	once         sync.Once
}

func gap(corr, paneID, reason string, sink Sink) *gapSession {
	s := &gapSession{corr: corr, paneID: paneID, sink: sink, reason: reason, done: make(chan struct{})}
	s.delivery = newDelivery(sink, nil)
	s.sink = func(e Event) error { s.delivery.offer(e); return nil }
	s.sink(Event{Kind: "coverage", Phase: "gap", Corr: corr, PaneID: paneID, Evidence: "backend_health", Reason: reason, Details: map[string]any{"child_exec_audit": false, "file_path_operations": false, "fd_io": false, "network_attempts": false, "network_flows": false, "desktop_causality": false}})
	return s
}
func (s *gapSession) Bind(pid int) {
	s.root, _ = Identity(pid)
	s.sink(Event{Kind: "process", Phase: "root_bound", Corr: s.corr, PaneID: s.paneID, Process: s.root, Root: s.root, Evidence: "launcher_pid", Details: map[string]any{"root_bindrace": !s.root.Valid()}})
}
func (s *gapSession) RootCompleted(code int) {
	defer s.Close("root_completed")
	s.sink(Event{Kind: "process", Phase: "root_completed", Corr: s.corr, PaneID: s.paneID, Root: s.root, Evidence: "launcher_wait", Details: map[string]any{"exit_code": code}})
}
func (s *gapSession) Close(string) {
	s.once.Do(func() {
		close(s.done)
		s.delivery.report(Event{Kind: "coverage", Phase: "gap", Corr: s.corr, PaneID: s.paneID, Evidence: "backend_health", Reason: s.reason, Details: map[string]any{"persistence": "unknown", "root_process_audit": s.root.PID > 0, "child_exec_audit": false, "file_path_operations": false, "fd_io": false, "network_attempts": false, "network_flows": false, "desktop_causality": false}})
		s.delivery.close()
	})
}
func (s *gapSession) Done() <-chan struct{}         { return s.done }
func (s *gapSession) RootIdentity() ProcessIdentity { return s.root }
func (s *gapSession) Health() Health {
	return Health{Corr: s.corr, State: "gap", Reason: s.reason, Persistence: "unknown"}
}

// Registry is scoped to an agent instance. Stop only stops observations.
type Registry struct {
	mu       sync.Mutex
	sessions map[Session]struct{}
	recent   []Health
}

func (r *Registry) Add(s Session) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.sessions == nil {
		r.sessions = map[Session]struct{}{}
	}
	r.sessions[s] = struct{}{}
	go func() {
		<-s.Done()
		r.mu.Lock()
		delete(r.sessions, s)
		r.recent = append(r.recent, s.Health())
		if len(r.recent) > 64 {
			r.recent = r.recent[len(r.recent)-64:]
		}
		r.mu.Unlock()
	}()
}
func (r *Registry) Stop(reason string) {
	r.mu.Lock()
	all := r.sessions
	r.sessions = nil
	r.mu.Unlock()
	for s := range all {
		s.Close(reason)
	}
}
func unavailable(cmd *exec.Cmd, corr, paneID string, sink Sink) (*exec.Cmd, Session, error) {
	return cmd, gap(corr, paneID, "backend_unavailable", sink), nil
}
func identityError(pid int) error { return fmt.Errorf("process %d identity unavailable", pid) }

func (r *Registry) Health() []Health {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := append([]Health{}, r.recent...)
	for s := range r.sessions {
		out = append(out, s.Health())
	}
	return out
}
