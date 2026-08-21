package main

import (
	"bufio"
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
	shellReadyWait   = 10 * time.Second
	promptPrefix     = "__FLEET_PROMPT__"
	doneMarkerPrefix = "__MCP_DONE__" // legacy; never written on the live path
)

type liveJob struct {
	pane      *pane
	command   string
	finishing bool
}

type liveShell struct {
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	mu       sync.Mutex
	rawOut   string
	rawErr   string
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

// parsePrompt finds PS1 '__FLEET_PROMPT__<exit>\n'. Hits followed by
// non-digits (an assignment echoing $?) are skipped. The prompt may sit on
// the same line as command output (printf '%s' with no trailing newline).
func parsePrompt(buf string) (output, rest string, exit int, ok bool) {
	return parseCompletion(buf, promptPrefix)
}

func parseCompletion(buf, marker string) (output, rest string, exit int, ok bool) {
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

func stripTermNoise(s string) string {
	s = strings.ReplaceAll(s, "\x1b[?2004h", "")
	s = strings.ReplaceAll(s, "\x1b[?2004l", "")
	s = strings.ReplaceAll(s, "\x1b[?2004H", "")
	s = strings.ReplaceAll(s, "\x1b[?2004L", "")
	return s
}

// stripEchoedCommand drops a line that is only the typed command (zsh/bash
// may still echo it on stderr even after stty -echo).
func stripEchoedCommand(s, command string) string {
	cmd := strings.TrimSpace(strings.TrimRight(command, "\n"))
	if cmd == "" || !strings.Contains(s, cmd) {
		return s
	}
	lines := strings.Split(s, "\n")
	keep := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.TrimSpace(line) == cmd {
			continue
		}
		keep = append(keep, line)
	}
	return strings.Join(keep, "\n")
}

func stripCompletionText(s string) string {
	s = stripTermNoise(s)
	for {
		out, rest, _, ok := parsePrompt(s)
		if !ok {
			break
		}
		s = out + rest
	}
	if !strings.Contains(s, promptPrefix) && !strings.Contains(s, doneMarkerPrefix) {
		return s
	}
	lines := strings.Split(s, "\n")
	keep := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.Contains(line, promptPrefix) || strings.Contains(line, doneMarkerPrefix) {
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
	_, _, _, ok := parsePrompt(buf)
	return ok
}

func (ls *liveShell) ingestReady(chunk string, readyCh chan struct{}) bool {
	ls.mu.Lock()
	if ls.ready {
		ls.mu.Unlock()
		return false
	}
	ls.rawOut += chunk
	if hasReadyLine(ls.rawOut) {
		ls.ready = true
		ls.rawOut = ""
		ls.rawErr = ""
		ls.mu.Unlock()
		select {
		case readyCh <- struct{}{}:
		default:
		}
		return true
	}
	ls.mu.Unlock()
	return true
}

func beginLiveIO(ls *liveShell, stdout, stderr io.Reader, readyCh chan struct{}) {
	go drainLive(stdout, func(chunk string) {
		if ls.ingestReady(chunk, readyCh) {
			return
		}
		ls.mu.Lock()
		cb := ls.onStdout
		ls.mu.Unlock()
		if cb != nil {
			cb(chunk)
		}
	}, func() { ls.markExit() })
	go drainLive(stderr, func(chunk string) {
		if ls.ingestReady(chunk, readyCh) {
			return
		}
		ls.mu.Lock()
		cb := ls.onStderr
		ls.mu.Unlock()
		if cb != nil {
			cb(chunk)
		}
	}, nil)
}

func waitLiveReady(ls *liveShell, stdin io.Writer, readyCh <-chan struct{}) {
	// One compound command so bash/zsh print a single completion prompt.
	// bash: \n in PS1 is a prompt escape. zsh: PROMPT=$'...%?\n'.
	_, _ = io.WriteString(stdin, "stty -echo 2>/dev/null || true; "+
		"bind 'set enable-bracketed-paste off' 2>/dev/null || true; "+
		"shopt -s expand_aliases 2>/dev/null || true; "+
		"setopt aliases 2>/dev/null || true; "+
		"unset PROMPT_COMMAND; PROMPT_COMMAND=; "+
		"precmd() { :; }; "+
		"PS1='"+promptPrefix+"$?\\n'; "+
		"PROMPT=$'"+promptPrefix+"%?\\n'\n")
	select {
	case <-readyCh:
	case <-time.After(shellReadyWait):
		ls.mu.Lock()
		ls.ready = true
		ls.rawOut = ""
		ls.rawErr = ""
		ls.mu.Unlock()
	}
	// Drop a trailing extra prompt before the first run is written.
	time.Sleep(50 * time.Millisecond)
	ls.mu.Lock()
	ls.rawOut = ""
	ls.rawErr = ""
	ls.mu.Unlock()
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
	time.Sleep(50 * time.Millisecond)
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
	cmd := job.command
	if !strings.HasSuffix(cmd, "\n") {
		cmd += "\n"
	}
	live.touch()
	live.mu.Lock()
	live.rawOut = ""
	live.rawErr = ""
	live.mu.Unlock()
	s.mu.Lock()
	s.pending = job
	if live.stdin != nil {
		job.pane.mu.Lock()
		job.pane.stdin = live.stdin
		job.pane.mu.Unlock()
	}
	s.mu.Unlock()
	// Only the user command. Completion is the PS1 prompt, not a printf on stdin.
	if err := live.write(cmd); err != nil {
		s.mu.Lock()
		if s.pending == job {
			s.pending = nil
		}
		s.mu.Unlock()
		return err
	}
	if _, isExit := exitCommandCode(job.command); isExit {
		go func() {
			time.Sleep(1500 * time.Millisecond)
			if job.pane.stillRunning() {
				live.kill()
			}
		}()
	}
	return nil
}

func (s *supervisor) onLiveStdout(chunk string) {
	s.feedLive("stdout", chunk)
}

func (s *supervisor) onLiveStderr(chunk string) {
	s.feedLive("stderr", chunk)
}

// feedLive records a chunk and completes the job when PS1 reappears.
// bash/zsh write the prompt to stderr, so both streams must be scanned.
func (s *supervisor) feedLive(which, chunk string) {
	s.mu.Lock()
	job := s.pending
	live := s.live
	s.mu.Unlock()
	if job == nil || live == nil {
		return
	}
	live.mu.Lock()
	if job.finishing {
		if which != "stderr" {
			live.rawOut += chunk
		} else {
			live.rawErr += chunk
		}
		live.mu.Unlock()
		return
	}
	if which == "stderr" {
		live.rawErr += chunk
	} else {
		live.rawOut += chunk
	}
	out, rest, code, ok := parsePrompt(live.rawOut)
	stderrBefore := live.rawErr
	fromStderr := false
	if ok {
		live.rawOut = rest
	} else if eout, erest, ecode, eok := parsePrompt(live.rawErr); eok {
		ok = true
		fromStderr = true
		code = ecode
		out = live.rawOut
		stderrBefore = eout
		live.rawErr = erest
	}
	if ok {
		job.finishing = true
		live.lastUsed = time.Now()
	}
	live.mu.Unlock()
	if !ok {
		cleaned := stripCompletionText(chunk)
		if cleaned != "" {
			job.pane.append(which, cleaned)
		}
		return
	}
	if fromStderr {
		// Prompt is on stderr; stdout may still be in the PTY read queue.
		time.Sleep(25 * time.Millisecond)
		live.mu.Lock()
		out = live.rawOut
		if o2, r2, _, ook := parsePrompt(out); ook {
			out = o2
			live.rawOut = r2
		} else {
			live.rawOut = ""
		}
		live.mu.Unlock()
	}
	s.mu.Lock()
	if s.pending == job {
		s.pending = nil
	}
	s.mu.Unlock()
	job.pane.finishCommand(out, code)
	job.pane.mu.Lock()
	job.pane.stderr = newStreamBuf()
	if cleaned := stripEchoedCommand(stripCompletionText(stderrBefore), job.command); cleaned != "" {
		job.pane.stderr.append(cleaned)
	}
	job.pane.mu.Unlock()
	go s.pumpLive()
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
	stdout = stripCompletionText(stdout)
	p.stdout = newStreamBuf()
	if stdout != "" {
		p.stdout.append(stdout)
	}
	if p.stderr != nil {
		cleaned := stripCompletionText(p.stderr.render())
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
