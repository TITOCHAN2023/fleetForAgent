//go:build linux

package hostaudit

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var traceLine = regexp.MustCompile(`^([0-9]+)\s+([0-9]+\.[0-9]+)\s+(.*)$`)
var callLine = regexp.MustCompile(`^([a-zA-Z_][a-zA-Z_0-9]*)\((.*)\)\s+=\s+(.*)$`)
var resumedLine = regexp.MustCompile(`^<\.\.\. ([a-zA-Z_][a-zA-Z_0-9]*) resumed>(.*)$`)
var quotedPath = regexp.MustCompile(`"(?:[^"\\]|\\.)*"`)

type traceParser struct {
	identities map[int]ProcessIdentity
	parents    map[int]ProcessIdentity
	pending    map[int]string
}

func newTraceParser() *traceParser {
	return &traceParser{identities: map[int]ProcessIdentity{}, parents: map[int]ProcessIdentity{}, pending: map[int]string{}}
}
func (p *traceParser) parse(line string) ([]Event, error) {
	f := traceLine.FindStringSubmatch(line)
	if len(f) != 4 {
		return nil, fmt.Errorf("unknown framing")
	}
	pid, _ := strconv.Atoi(f[1])
	body := f[3]
	if strings.HasPrefix(body, "--- ") {
		return nil, nil
	}
	if strings.HasPrefix(body, "+++ ") {
		delete(p.pending, pid)
		identity := p.identity(pid)
		parent := p.parents[pid]
		delete(p.identities, pid)
		delete(p.parents, pid)
		return []Event{{Kind: "process", Phase: "exited", Process: identity, Parent: parent, Evidence: "ptrace_exit", Details: map[string]any{"timestamp": f[2]}}}, nil
	}
	if strings.HasSuffix(body, "<unfinished ...>") {
		if len(p.pending) >= 4096 {
			return nil, fmt.Errorf("pending limit")
		}
		p.pending[pid] = strings.TrimSuffix(body, "<unfinished ...>")
		return nil, nil
	}
	if r := resumedLine.FindStringSubmatch(body); len(r) == 3 {
		prior, ok := p.pending[pid]
		delete(p.pending, pid)
		if !ok || !strings.HasPrefix(prior, r[1]+"(") {
			return nil, fmt.Errorf("resume without begin")
		}
		body = prior + r[2]
	}
	call := callLine.FindStringSubmatch(body)
	if len(call) != 4 {
		return nil, fmt.Errorf("unknown call")
	}
	method, args, result := call[1], call[2], call[3]
	if len(strings.Fields(result)) == 0 {
		return nil, fmt.Errorf("missing syscall result")
	}
	event := Event{Kind: "os_event", Phase: "observed", Operation: method, Process: p.identity(pid), Parent: p.parents[pid], Evidence: "ptrace_syscall", Details: map[string]any{"timestamp": f[2], "result": result, "process_identity_gap": !p.identity(pid).Valid(), "path_truncated": strings.Contains(args, `"...`)}}
	switch method {
	case "clone", "clone3", "fork", "vfork":
		event.Kind = "process"
		event.Phase = "fork"
		child, _ := strconv.Atoi(strings.Fields(result)[0])
		if child > 0 {
			parent := p.identity(pid)
			p.parents[child] = parent
			childID := p.identity(child)
			event.Details["child_pid"] = child
			event.Details["child_start_id"] = childID.StartID
			event.Details["child_identity_gap"] = !childID.Valid()
		}
	case "execve", "execveat":
		event.Kind = "process"
		event.Phase = "exec_attempt"
	case "exit", "exit_group":
		event.Kind = "process"
		event.Phase = "exit_requested"
	case "read", "write", "pread64", "pwrite64", "readv", "writev", "preadv", "pwritev", "close":
		event.Kind = "fd_io"
		event.Details["fd"] = firstArgument(args)
		event.Details["fd_path_resolution"] = false
	case "sendto", "recvfrom", "sendmsg", "recvmsg", "sendmmsg", "recvmmsg":
		event.Kind = "network_io"
		event.Details["fd"] = firstArgument(args)
		event.Details["peer_resolution"] = false
		event.Details["flow_complete"] = false
	case "socket", "socketpair", "connect", "bind", "listen", "accept", "accept4", "shutdown":
		event.Kind = "network_attempt"
		event.Details["fd"] = firstArgument(args)
		event.Details["endpoint_metadata"] = args
		event.Details["flow_complete"] = false
	case "open", "openat", "openat2", "creat", "unlink", "unlinkat", "rename", "renameat", "renameat2", "mkdir", "mkdirat", "rmdir", "chdir", "fchdir", "link", "linkat", "symlink", "symlinkat", "readlink", "readlinkat", "stat", "lstat", "newfstatat", "statx", "access", "faccessat", "faccessat2", "chmod", "fchmodat", "chown", "fchownat":
		event.Kind = "file_path_operation"
		paths := quotedPath.FindAllString(args, -1)
		if len(paths) > 0 {
			event.Details["path"] = paths[0]
		}
		if len(paths) > 1 {
			event.Details["second_path"] = paths[1]
		}
		event.Details["relative_path_resolution"] = false
	default:
		return nil, fmt.Errorf("unknown method")
	}
	return []Event{event}, nil
}
func firstArgument(args string) string {
	f := strings.SplitN(args, ",", 2)
	if len(f) == 0 {
		return ""
	}
	return strings.TrimSpace(f[0])
}

// A delayed text record cannot prove that a current /proc PID is its process.
// Only launch-time kernel-bound identities are trusted. Descendants carry the
// observed PID and fork ancestry, with an explicit stable-identity gap.
func (p *traceParser) identity(pid int) ProcessIdentity {
	if id, ok := p.identities[pid]; ok {
		return id
	}
	return ProcessIdentity{PID: pid}
}
