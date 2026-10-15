//go:build linux

package hostaudit

import (
	"bytes"
	"context"
	"fmt"
	"golang.org/x/sys/unix"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Explicit methods only. Buffers and exec arguments are raw pointers: no argv,
// env, stdin/stdout, send/recv content is decoded or persisted.
const methods = "clone,clone3,fork,vfork,execve,execveat,exit,exit_group,open,openat,openat2,creat,close,read,write,pread64,pwrite64,readv,writev,preadv,pwritev,unlink,unlinkat,rename,renameat,renameat2,mkdir,mkdirat,rmdir,chdir,fchdir,link,linkat,symlink,symlinkat,readlink,readlinkat,stat,lstat,newfstatat,statx,access,faccessat,faccessat2,chmod,fchmodat,chown,fchownat,socket,socketpair,connect,bind,listen,accept,accept4,shutdown,sendto,recvfrom,sendmsg,recvmsg,sendmmsg,recvmmsg"
const rawMethods = "execve,execveat,read,write,pread64,pwrite64,readv,writev,preadv,pwritev,sendto,recvfrom,sendmsg,recvmsg,sendmmsg,recvmmsg"

// Same root PID throughout. The gate provides a live kernel-backed tracer bind
// before workload exec. Its timeout fails open exactly once, with a bind gap.
const trampoline = `exec 2>/dev/tty
bind=$1; ack=$2; shift 2
while read k v rest; do case "$k" in TracerPid:) printf '%s %s\n' "$$" "$v" > "$bind"; break;; esac; done < /proc/self/status
n=0
while [ ! -e "$ack" ] && [ "$n" -lt 200 ]; do sleep .01; n=$((n+1)); done
exec "$@"`

type linuxSession struct {
	mu                                sync.Mutex
	once                              sync.Once
	sinkFailure                       sync.Once
	queueOverflow                     sync.Once
	delivery                          *delivery
	healthState                       Health
	stopping                          bool
	sink                              Sink
	corr, paneID, dir, tracePath, exe string
	opts                              Options
	root, tracer                      ProcessIdentity
	diag                              *os.File
	done                              chan struct{}
	bindReady                         chan struct{}
	rootDone                          bool
	events                            int
	parser                            *traceParser
}

func OptIn(value string) bool { return value == "linux-strace" }

func CapabilitiesForHost(enabled bool) Capabilities {
	state := "not_enabled"
	if enabled {
		state = "opt_in_probe_required"
	}
	return Capabilities{Backend: "linux_strace", State: state, Scope: "experimental_explicit_syscall_methods", ProcessLifecycle: true, FilePathOperations: true, FDIO: true, NetworkAttempts: true}
}
func traceArgs(path string, limit int) []string {
	return []string{"-DDD", "-I", "2", "-f", "-ttt", "-s", "256", "--syscall-limit=" + strconv.Itoa(limit), "-e", "trace=" + methods, "-e", "raw=" + rawMethods, "-o", path, "--"}
}

// Probe never executes the caller's command. No fallback can duplicate it.
func probe(exe string) bool {
	dir, e := os.MkdirTemp("", "fleet-hostaudit-probe-")
	if e != nil {
		return false
	}
	defer os.RemoveAll(dir)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	args := append(traceArgs(filepath.Join(dir, "trace"), 1000), "/bin/sh", "-c", "exit 0")
	c := exec.CommandContext(ctx, exe, args...)
	c.Stdout = io.Discard
	c.Stderr = io.Discard
	if c.Run() != nil {
		return false
	}
	b, e := os.ReadFile(filepath.Join(dir, "trace"))
	return e == nil && bytes.Contains(b, []byte("execve("))
}
func prepare(cmd *exec.Cmd, corr, paneID string, opts Options, sink Sink) (*exec.Cmd, Session, error) {
	exe, e := exec.LookPath("strace")
	if e != nil || !probe(exe) {
		return cmd, gap(corr, paneID, "probe_failed_or_permission_denied", sink), nil
	}
	exe, _ = filepath.EvalSymlinks(exe)
	dir, e := os.MkdirTemp("", "fleet-hostaudit-")
	if e != nil {
		return nil, nil, e
	}
	diag, e := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if e != nil {
		os.RemoveAll(dir)
		return nil, nil, e
	}
	path := filepath.Join(dir, "trace")
	// A bounded FIFO means even malicious high-volume tracees cannot grow disk.
	if e = unix.Mkfifo(path, 0600); e != nil {
		diag.Close()
		os.RemoveAll(dir)
		return nil, nil, e
	}
	fd, e := unix.Open(path, unix.O_RDWR|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if e != nil {
		diag.Close()
		os.RemoveAll(dir)
		return nil, nil, e
	}
	pipe := os.NewFile(uintptr(fd), path)
	s := &linuxSession{sink: sink, corr: corr, paneID: paneID, dir: dir, tracePath: path, exe: exe, opts: opts, diag: diag, done: make(chan struct{}), bindReady: make(chan struct{}), parser: newTraceParser()}
	original := append([]string{}, cmd.Args...)
	args := append(traceArgs(path, opts.MaxEvents), "/bin/sh", "-c", trampoline, "fleet-hostaudit", filepath.Join(dir, "bind"), filepath.Join(dir, "ack"))
	args = append(args, original...)
	cmd.Path = exe
	cmd.Args = append([]string{exe}, args...)
	cmd.Stderr = diag
	s.healthState = Health{Corr: corr, State: "preparing", Persistence: "best_effort", Detach: "not_requested"}
	s.delivery = newDelivery(sink, func() { s.sinkFailure.Do(func() { s.Close("journal_unavailable") }) })
	go s.collect(pipe)
	return cmd, s, nil
}
func (s *linuxSession) event(e Event) Event {
	e.Corr = s.corr
	e.PaneID = s.paneID
	s.mu.Lock()
	e.Root = s.root
	e.Details = copyDetails(e.Details)
	e.Details["root_completed"] = s.rootDone
	s.mu.Unlock()
	return e
}
func (s *linuxSession) emit(e Event) {
	if !s.delivery.offer(s.event(e)) {
		s.queueOverflow.Do(func() { go s.Close("metadata_queue_full_lost") })
	}
}
func (s *linuxSession) Health() Health { s.mu.Lock(); defer s.mu.Unlock(); return s.healthState }
func copyDetails(m map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range m {
		out[k] = v
	}
	return out
}
func (s *linuxSession) Bind(pid int) {
	defer func() {
		close(s.bindReady)
		go func() {
			select {
			case <-time.After(s.opts.Lease):
				s.Close("lease_expired")
			case <-s.done:
			}
		}()
	}()
	initial, _ := Identity(pid)
	s.mu.Lock()
	s.root = initial
	s.mu.Unlock()
	deadline := time.Now().Add(2200 * time.Millisecond)
	for time.Now().Before(deadline) {
		b, e := os.ReadFile(filepath.Join(s.dir, "bind"))
		fields := strings.Fields(string(b))
		if e == nil && len(fields) == 2 {
			rootPID, _ := strconv.Atoi(fields[0])
			tracerPID, _ := strconv.Atoi(fields[1])
			root, re := Identity(pid)
			tracer, te := Identity(tracerPID)
			status, _ := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
			sid, se := unix.Getsid(tracerPID)
			actualExe, xe := os.Readlink(fmt.Sprintf("/proc/%d/exe", tracerPID))
			linked := false
			for _, line := range strings.Split(string(status), "\n") {
				if strings.HasPrefix(line, "TracerPid:") {
					f := strings.Fields(line)
					linked = len(f) == 2 && f[1] == fields[1]
				}
			}
			if rootPID == pid && re == nil && te == nil && tracer.Valid() && linked && se == nil && sid == tracerPID && xe == nil && actualExe == s.exe {
				s.mu.Lock()
				if s.stopping {
					s.mu.Unlock()
					_ = os.WriteFile(filepath.Join(s.dir, "ack"), []byte("unobserved\n"), 0600)
					return
				}
				s.root = root
				s.healthState.State = "active"
				s.tracer = tracer
				s.parser.identities[pid] = root
				s.mu.Unlock()
				s.emit(Event{Kind: "coverage", Phase: "active", Evidence: "backend_health", Details: map[string]any{"backend": "linux_strace", "scope": "experimental_explicit_syscall_methods", "experimental": true, "ptrace_changes_scheduling": true, "setuid_debugger_compatibility": false, "methods": methods, "file_path_operations": true, "fd_io": true, "network_attempts": true, "network_flows": false, "desktop_causality": false, "tamperproof": false}})
				s.emit(Event{Kind: "process", Phase: "root_bound", Process: root, Evidence: "kernel_tracer_link", Details: map[string]any{"root_bindrace": false, "tracer_pid": tracer.PID, "tracer_start_id": tracer.StartID}})
				_ = os.WriteFile(filepath.Join(s.dir, "ack"), []byte("bound\n"), 0600)
				return
			}
		}
		select {
		case <-s.done:
			return
		case <-time.After(5 * time.Millisecond):
		}
	}
	s.mu.Lock()
	if !s.stopping {
		s.healthState.State = "gap"
		s.healthState.Reason = "root_bindrace"
	}
	s.mu.Unlock()
	s.emit(Event{Kind: "coverage", Phase: "gap", Evidence: "backend_health", Reason: "root_bindrace", Details: map[string]any{"root_bindrace": true}})
}
func (s *linuxSession) cleanupArtifacts() {
	s.mu.Lock()
	completed := s.rootDone
	root := s.root
	s.mu.Unlock()
	if completed || root.PID == 0 {
		_ = os.RemoveAll(s.dir)
	}
}
func (s *linuxSession) RootCompleted(code int) {
	s.mu.Lock()
	s.rootDone = true
	s.mu.Unlock()
	s.emit(Event{Kind: "process", Phase: "root_completed", Evidence: "launcher_wait", Details: map[string]any{"exit_code": code}})
	select {
	case <-s.done:
		s.cleanupArtifacts()
	default:
	}
}
func (s *linuxSession) Done() <-chan struct{} { return s.done }
func (s *linuxSession) RootIdentity() ProcessIdentity {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.root
}
func (s *linuxSession) Close(reason string) {
	s.once.Do(func() {
		s.mu.Lock()
		s.stopping = true
		s.healthState.State = "stopped_gap"
		s.healthState.Reason = reason
		s.healthState.Persistence = "unknown"
		s.healthState.Detach = "unconfirmed"
		s.mu.Unlock()
		s.mu.Lock()
		tracer := s.tracer
		s.mu.Unlock()
		// Handshake files are not a security boundary. Recheck kernel identity and
		// executable/session immediately before signal; pidfd prevents PID reuse.
		if tracer.Valid() {
			fd, e := unix.PidfdOpen(tracer.PID, 0)
			if e == nil {
				defer unix.Close(fd)
				now, ie := Identity(tracer.PID)
				exe, xe := os.Readlink(fmt.Sprintf("/proc/%d/exe", tracer.PID))
				sid, se := unix.Getsid(tracer.PID)
				if ie == nil && now == tracer && xe == nil && exe == s.exe && se == nil && sid == tracer.PID {
					if unix.PidfdSendSignal(fd, unix.SIGINT, nil, 0) == nil {
						s.mu.Lock()
						s.healthState.Detach = "signal_sent_verified_pidfd"
						s.mu.Unlock()
					}
				} else {
					s.mu.Lock()
					s.healthState.Detach = "identity_unconfirmed_no_signal"
					s.mu.Unlock()
				}
			} else {
				s.mu.Lock()
				s.healthState.Detach = "pidfd_unavailable_no_signal"
				s.mu.Unlock()
			}
		}
		close(s.done)
		health := s.Health()
		s.delivery.report(s.event(Event{Kind: "coverage", Phase: "gap", Evidence: "backend_health", Reason: reason, Details: map[string]any{"persistence": "unknown", "detach": health.Detach, "queued_event_loss_possible": true}}))
		s.delivery.close()
	})
}
func (s *linuxSession) collect(pipe *os.File) {
	defer pipe.Close()
	defer s.diag.Close()
	defer s.cleanupArtifacts()

	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	pending := []byte{}
	buf := make([]byte, 32768)
	for {
		select {
		case <-s.done:
			return
		case <-tick.C:
		}

		n, e := unix.Read(int(pipe.Fd()), buf)
		if n > 0 {
			pending = append(pending, buf[:n]...)
		}
		if e != nil && e != io.EOF && !os.IsTimeout(e) && e != unix.EAGAIN {
			s.Close("collector_read_error")
			return
		}
		if len(pending) > 65536 {
			s.Close("parser_line_limit_lost")
			return
		}
		select {
		case <-s.bindReady:
		default:
			continue
		}
		for {
			i := bytes.IndexByte(pending, '\n')
			if i < 0 {
				break
			}
			line := string(pending[:i])
			pending = pending[i+1:]
			s.mu.Lock()
			events, err := s.parser.parse(line)
			s.mu.Unlock()
			if err != nil {
				s.emit(Event{Kind: "coverage", Phase: "lost", Evidence: "parser", Reason: "unparsed_trace_record", Details: map[string]any{"lost_records": 1}})
			}
			for _, event := range events {
				s.events++
				s.emit(event)
			}
			if s.events >= s.opts.MaxEvents {
				s.Close("event_limit_lost")
				return
			}
		}
		s.mu.Lock()
		tracer := s.tracer
		s.mu.Unlock()
		if tracer.Valid() {
			p, err := Identity(tracer.PID)
			if err != nil || p != tracer {
				s.emit(Event{Kind: "coverage", Phase: "stopped", Evidence: "backend_health", Reason: "tracer_exited_or_limit_reached", Details: map[string]any{"tail_or_limit_loss_possible": true}})
				s.Close("tracer_exited_or_limit_reached")
				return
			}
		}
	}
}
