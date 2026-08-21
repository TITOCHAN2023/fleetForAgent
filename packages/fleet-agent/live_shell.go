package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	shellIdleFor     = 2 * time.Hour
	shellReadyMark   = "__FLEET_SHELL_READY__"
	shellReadyWait   = 10 * time.Second
	doneMarkerPrefix = "__MCP_DONE__"
)

type liveJob struct {
	pane    *pane
	command string
	marker  string
}

type liveShell struct {
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	mu       sync.Mutex
	rawOut   string
	ready    bool
	exited   bool
	lastUsed time.Time
	idleFor  time.Duration
	onStdout func(string)
	onStderr func(string)
	onExit   func()
}

func fileExists(path string) bool {
	st, err := os.Stat(path)
	return err == nil && !st.IsDir()
}

func usableShell(path string) bool {
	path = strings.TrimSpace(path)
	if path == "" || !fileExists(path) {
		return false
	}
	base := filepath.Base(path)
	if base == "nologin" || base == "false" || base == "sync" {
		return false
	}
	return true
}

func userHome() string {
	if h, err := os.UserHomeDir(); err == nil && strings.TrimSpace(h) != "" {
		return h
	}
	if h := strings.TrimSpace(os.Getenv("HOME")); h != "" {
		return h
	}
	return ""
}

// pickShell is the account login shell, not inherited $SHELL from the launcher.
// FLEET_SHELL wins when set. Darwin uses dscl; elsewhere getent/passwd.
func pickShell() string {
	if s := strings.TrimSpace(os.Getenv("FLEET_SHELL")); usableShell(s) {
		return s
	}
	if s := accountLoginShell(); usableShell(s) {
		return s
	}
	if runtime.GOOS == "darwin" && usableShell("/bin/zsh") {
		return "/bin/zsh"
	}
	if usableShell("/bin/bash") {
		return "/bin/bash"
	}
	return "/bin/sh"
}

func accountUser() string {
	if u := strings.TrimSpace(os.Getenv("USER")); u != "" {
		return u
	}
	if u := strings.TrimSpace(os.Getenv("LOGNAME")); u != "" {
		return u
	}
	if u, err := user.Current(); err == nil && u != nil && u.Username != "" {
		return u.Username
	}
	return ""
}

func accountLoginShell() string {
	name := accountUser()
	if runtime.GOOS == "darwin" && name != "" {
		out, err := exec.Command("dscl", ".", "-read", "/Users/"+name, "UserShell").Output()
		if err == nil {
			line := strings.TrimSpace(string(out))
			if i := strings.LastIndex(line, " "); i >= 0 {
				s := strings.TrimSpace(line[i+1:])
				if strings.HasPrefix(s, "/") {
					return s
				}
			}
		}
	}
	if name != "" {
		if s := loginShellFromPasswd(name); s != "" {
			return s
		}
	}
	return ""
}

func loginShellFromPasswd(name string) string {
	if out, err := exec.Command("getent", "passwd", name).Output(); err == nil {
		if s := passwdShellField(string(out)); s != "" {
			return s
		}
	}
	f, err := os.Open("/etc/passwd")
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, name+":") {
			continue
		}
		return passwdShellField(line)
	}
	return ""
}

func passwdShellField(line string) string {
	parts := strings.Split(strings.TrimSpace(line), ":")
	if len(parts) >= 7 {
		return strings.TrimSpace(parts[6])
	}
	return ""
}

func newMarkerToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// parseDoneMarker finds printf '__MCP_DONE__{uuid}__%d\n' $? output.
// marker is "__MCP_DONE__{uuid}__" then digits and newline. Hits followed by
// non-digits (the echoed printf '%d' source) are skipped. The marker may sit
// on the same line as command output (printf '%s' with no trailing newline).
func parseDoneMarker(buf, marker string) (output, rest string, exit int, ok bool) {
	if marker == "" {
		return "", buf, 0, false
	}
	start := 0
	for {
		rel := strings.Index(buf[start:], marker)
		if rel < 0 {
			return "", buf, 0, false
		}
		i := start + rel
		after := buf[i+len(marker):]
		nl := strings.IndexByte(after, '\n')
		if nl < 0 {
			return "", buf, 0, false
		}
		codeStr := strings.TrimSpace(strings.TrimSuffix(after[:nl], "\r"))
		code, err := strconv.Atoi(codeStr)
		if err != nil {
			start = i + len(marker)
			continue
		}
		return strings.ReplaceAll(buf[:i], "\r", ""), after[nl+1:], code, true
	}
}

func stripReadyNoise(s string) string {
	if !strings.Contains(s, shellReadyMark) {
		return s
	}
	s = strings.ReplaceAll(s, shellReadyMark+"\n", "")
	s = strings.ReplaceAll(s, shellReadyMark, "")
	return s
}

func stripDoneLines(s string) string {
	if !strings.Contains(s, doneMarkerPrefix) {
		return s
	}
	lines := strings.Split(s, "\n")
	keep := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.Contains(line, doneMarkerPrefix) {
			continue
		}
		keep = append(keep, line)
	}
	return strings.Join(keep, "\n")
}

// exitCommandCode reports the code for a bare `exit` / `exit N` command.
// Compound commands are left to the marker / process-death path.
func exitCommandCode(command string) (int, bool) {
	s := strings.TrimSpace(command)
	if s == "" || strings.ContainsAny(s, ";&|") {
		return 0, false
	}
	fields := strings.Fields(s)
	if len(fields) == 0 || fields[0] != "exit" {
		return 0, false
	}
	if len(fields) == 1 {
		return 0, true
	}
	n, err := strconv.Atoi(fields[1])
	if err != nil {
		return 0, true
	}
	return n, true
}

func hasReadyLine(buf string) bool {
	s := strings.ReplaceAll(buf, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	for _, line := range strings.Split(s, "\n") {
		if line == shellReadyMark {
			return true
		}
	}
	return false
}

func beginLiveIO(ls *liveShell, stdout, stderr io.Reader, readyCh chan struct{}) {
	go drainLive(stdout, func(chunk string) {
		ls.mu.Lock()
		if !ls.ready {
			ls.rawOut += chunk
			if hasReadyLine(ls.rawOut) {
				ls.ready = true
				ls.rawOut = ""
				ls.mu.Unlock()
				select {
				case readyCh <- struct{}{}:
				default:
				}
				return
			}
			ls.mu.Unlock()
			return
		}
		cb := ls.onStdout
		ls.mu.Unlock()
		if cb != nil {
			cb(chunk)
		}
	}, func() { ls.markExit() })
	go drainLive(stderr, func(chunk string) {
		ls.mu.Lock()
		cb := ls.onStderr
		ready := ls.ready
		ls.mu.Unlock()
		if ready && cb != nil {
			cb(chunk)
		}
	}, nil)
}

func waitLiveReady(ls *liveShell, stdin io.Writer, readyCh <-chan struct{}) {
	_, _ = io.WriteString(stdin, "export PS1=\"\"\n")
	_, _ = io.WriteString(stdin, "stty -echo 2>/dev/null || true\n")
	// -il still needs expand_aliases on bash; setopt is the zsh equivalent.
	_, _ = io.WriteString(stdin, "shopt -s expand_aliases 2>/dev/null || true\n")
	_, _ = io.WriteString(stdin, "setopt aliases 2>/dev/null || true\n")
	_, _ = io.WriteString(stdin, "printf '%s\\n' '"+shellReadyMark+"'\n")
	select {
	case <-readyCh:
	case <-time.After(shellReadyWait):
		ls.mu.Lock()
		ls.ready = true
		ls.rawOut = ""
		ls.mu.Unlock()
	}
}

func drainLive(r io.Reader, onChunk func(string), onEOF func()) {
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 && onChunk != nil {
			onChunk(string(buf[:n]))
		}
		if err != nil {
			if onEOF != nil {
				onEOF()
			}
			return
		}
	}
}

func (ls *liveShell) markExit() {
	ls.mu.Lock()
	if ls.exited {
		ls.mu.Unlock()
		return
	}
	ls.exited = true
	cb := ls.onExit
	ls.mu.Unlock()
	if cb != nil {
		cb()
	}
}

func (ls *liveShell) alive() bool {
	ls.mu.Lock()
	defer ls.mu.Unlock()
	return ls.cmd != nil && !ls.exited
}

func (ls *liveShell) idleExpired() bool {
	ls.mu.Lock()
	defer ls.mu.Unlock()
	idle := ls.idleFor
	if idle <= 0 {
		idle = shellIdleFor
	}
	return time.Since(ls.lastUsed) > idle
}

func (ls *liveShell) touch() {
	ls.mu.Lock()
	ls.lastUsed = time.Now()
	ls.mu.Unlock()
}

func (ls *liveShell) write(s string) error {
	if ls.stdin == nil {
		return io.ErrClosedPipe
	}
	_, err := io.WriteString(ls.stdin, s)
	return err
}

func (ls *liveShell) kill() {
	ls.mu.Lock()
	cmd := ls.cmd
	stdin := ls.stdin
	ls.cmd = nil
	ls.exited = true
	ls.mu.Unlock()
	if stdin != nil {
		_ = stdin.Close()
	}
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

func (s *supervisor) enqueueLive(corr, command string) (*pane, error) {
	p := &pane{
		id:      "pane-" + corr,
		corr:    corr,
		command: command,
		running: true,
		lines:   []string{""},
		stdout:  newStreamBuf(),
		stderr:  newStreamBuf(),
	}
	s.mu.Lock()
	s.panes[p.id] = p
	if corr != "" {
		s.panes[corr] = p
	}
	s.order = append(s.order, p.id)
	s.queue = append(s.queue, &liveJob{pane: p, command: command})
	s.mu.Unlock()
	go s.pumpLive()
	return p, nil
}

func (s *supervisor) pumpLive() {
	s.mu.Lock()
	if s.pumping {
		s.mu.Unlock()
		return
	}
	s.pumping = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.pumping = false
		s.mu.Unlock()
	}()

	for {
		s.mu.Lock()
		if s.pending != nil {
			s.mu.Unlock()
			return
		}
		if len(s.queue) == 0 {
			s.mu.Unlock()
			return
		}
		job := s.queue[0]
		s.queue = s.queue[1:]
		s.mu.Unlock()

		if err := s.ensureLive(); err != nil {
			s.failLiveJob(job, err.Error())
			continue
		}
		if err := s.startLiveJob(job); err != nil {
			s.failLiveJob(job, err.Error())
			continue
		}
		return
	}
}

func (s *supervisor) ensureLive() error {
	s.mu.Lock()
	live := s.live
	s.mu.Unlock()
	if live != nil && live.alive() && !live.idleExpired() {
		return nil
	}
	if live != nil {
		live.kill()
	}
	next, err := startLiveShell()
	if err != nil {
		s.mu.Lock()
		s.live = nil
		s.mu.Unlock()
		return err
	}
	next.onStdout = func(chunk string) { s.onLiveStdout(chunk) }
	next.onStderr = func(chunk string) { s.onLiveStderr(chunk) }
	next.onExit = func() { s.onLiveExit() }
	s.mu.Lock()
	s.live = next
	s.mu.Unlock()
	return nil
}

func (s *supervisor) startLiveJob(job *liveJob) error {
	s.mu.Lock()
	live := s.live
	s.mu.Unlock()
	if live == nil {
		return fmt.Errorf("live shell gone")
	}
	token := newMarkerToken()
	job.marker = doneMarkerPrefix + token + "__"
	cmd := job.command
	if !strings.HasSuffix(cmd, "\n") {
		cmd += "\n"
	}
	live.touch()
	live.mu.Lock()
	live.rawOut = ""
	live.mu.Unlock()
	s.mu.Lock()
	s.pending = job
	if live.stdin != nil {
		job.pane.mu.Lock()
		job.pane.stdin = live.stdin
		job.pane.mu.Unlock()
	}
	s.mu.Unlock()
	if err := live.write(cmd); err != nil {
		s.mu.Lock()
		if s.pending == job {
			s.pending = nil
		}
		s.mu.Unlock()
		return err
	}
	// `exit` closes the login shell before the marker can run; wait for onLiveExit.
	if _, isExit := exitCommandCode(job.command); !isExit {
		if err := live.write(fmt.Sprintf("printf '%s%%d\\n' $?\n", job.marker)); err != nil {
			s.mu.Lock()
			if s.pending == job {
				s.pending = nil
			}
			s.mu.Unlock()
			return err
		}
	}
	return nil
}

func (s *supervisor) onLiveStdout(chunk string) {
	s.mu.Lock()
	job := s.pending
	live := s.live
	s.mu.Unlock()
	if job == nil || live == nil {
		return
	}
	live.mu.Lock()
	live.rawOut += chunk
	out, rest, code, ok := parseDoneMarker(live.rawOut, job.marker)
	if ok {
		live.rawOut = rest
		live.lastUsed = time.Now()
	}
	live.mu.Unlock()
	if !ok {
		job.pane.append("stdout", chunk)
		return
	}
	s.mu.Lock()
	if s.pending == job {
		s.pending = nil
	}
	s.mu.Unlock()
	job.pane.finishCommand(stripReadyNoise(out), code)
	go s.pumpLive()
}

func (s *supervisor) onLiveStderr(chunk string) {
	s.mu.Lock()
	job := s.pending
	s.mu.Unlock()
	if job == nil {
		return
	}
	chunk = stripDoneLines(chunk)
	if chunk == "" {
		return
	}
	job.pane.append("stderr", chunk)
}

func (s *supervisor) onLiveExit() {
	s.mu.Lock()
	job := s.pending
	s.pending = nil
	if s.live != nil {
		s.live = nil
	}
	s.mu.Unlock()
	if job != nil && job.pane.stillRunning() {
		code := 1
		if c, ok := exitCommandCode(job.command); ok {
			code = c
		}
		job.pane.finishCommand("", code)
	}
	go s.pumpLive()
}

func (s *supervisor) failLiveJob(job *liveJob, msg string) {
	if job == nil || job.pane == nil {
		return
	}
	job.pane.append("stderr", msg+"\n")
	job.pane.finishCommand("", 1)
}

func (p *pane) stillRunning() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.running
}

func (p *pane) finishCommand(stdout string, code int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	stdout = stripDoneLines(stripReadyNoise(stdout))
	p.stdout = newStreamBuf()
	if stdout != "" {
		p.stdout.append(stdout)
	}
	if p.stderr != nil {
		cleaned := stripDoneLines(p.stderr.render())
		p.stderr = newStreamBuf()
		if cleaned != "" {
			p.stderr.append(cleaned)
		}
	}
	p.lines = []string{""}
	if stdout != "" {
		p.appendDisplayLocked(stdout)
	}
	p.running = false
	p.exitCode = code
	p.dirty = true
}
