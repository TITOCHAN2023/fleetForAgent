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
	childQuietFor    = 200 * time.Millisecond
	promptPrefix     = "__FLEET_PROMPT__"
	doneMarkerPrefix = "__MCP_DONE__" // legacy; never written on the live path
	rawOutMaxBytes   = 64 * 1024
	// marker + CSI around the exit + CR/LF, plus a split-chunk lookbehind
	promptScanTail = len(promptPrefix) + 48
)

func appendCappedRaw(buf, chunk string) string {
	if chunk == "" {
		return buf
	}
	n := len(buf) + len(chunk)
	if n <= rawOutMaxBytes {
		return buf + chunk
	}
	if len(chunk) >= rawOutMaxBytes {
		return chunk[len(chunk)-rawOutMaxBytes:]
	}
	return buf[n-rawOutMaxBytes:] + chunk
}

// scanPrompt looks only at a small tail so a long job is not re-parsed
// from the start on every PTY chunk. Lookbehind covers a marker split
// across the last write.
func scanPrompt(buf string) bool {
	if buf == "" {
		return false
	}
	tail := buf
	if len(tail) > promptScanTail {
		tail = tail[len(tail)-promptScanTail:]
	}
	return hasReadyLine(tail)
}

type liveJob struct {
	pane        *pane
	command     string
	fingerprint string
	finishing   bool
}

type liveShell struct {
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	mu         sync.Mutex
	writeMu    sync.Mutex
	screen     *vtScreen
	screenIdle bool // after a corr finishes, ignore PTY bytes until the next run
	rawOut     string
	rawErr     string
	ready      bool
	exited     bool
	lastUsed   time.Time
	idleFor    time.Duration
	onStdout   func(string)
	onStderr   func(string)
	onExit     func()
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
	out, rest, code, ok := parseCompletion(buf, promptPrefix)
	if ok {
		return out, rest, code, true
	}
	// TUI teardown often wraps PS1 in CSI. Strip for the match only.
	stripped := stripANSI(buf)
	if stripped == buf {
		return "", buf, 0, false
	}
	return parseCompletion(stripped, promptPrefix)
}

// rawOutputBeforePrompt is the PTY byte prefix before `__FLEET_PROMPT__`,
// CSI and CR included. Replayed through a fresh emulator so color/CUP
// become the last human frame instead of being discarded.
func rawOutputBeforePrompt(buf string) string {
	i := strings.Index(buf, promptPrefix)
	if i < 0 {
		return buf
	}
	return buf[:i]
}

// replayAfterFinish keeps the last human frame for a short command
// (CUP, color). Interactive TUIs leave the blank reset grid: they
// probed DA/CPR, entered the alt screen, waited for type, or finished
// on the child-quiet path.
func replayAfterFinish(ps1 bool, force, usedAlt, answered, typed bool) bool {
	return ps1 && !force && !usedAlt && !answered && !typed
}

// keepCommandStdout is the get_result.stdout policy. Short commands
// keep the PTY prefix (`hi`, `got=ok`, color CSI). Interactive TUIs
// use the human frame (blank after reset) instead of the raw dump.
func keepCommandStdout(ps1 bool, force, usedAlt, answered, typed bool, out string) bool {
	if usedAlt || force {
		return false
	}
	if typed && (answered || strings.Contains(out, "\x1b")) {
		return false
	}
	return true
}

func stripANSI(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	i := 0
	for i < len(s) {
		if s[i] == 0x1b && i+1 < len(s) && s[i+1] == '[' {
			i += 2
			for i < len(s) && (s[i] < 0x40 || s[i] > 0x7e) {
				i++
			}
			if i < len(s) {
				i++
			}
			continue
		}
		if s[i] == 0x1b && i+1 < len(s) && (s[i+1] == ']' || s[i+1] == 'P' || s[i+1] == 'X' || s[i+1] == '^' || s[i+1] == '_') {
			i += 2
			for i < len(s) {
				if s[i] == 0x07 {
					i++
					break
				}
				if s[i] == 0x1b && i+1 < len(s) && s[i+1] == '\\' {
					i += 2
					break
				}
				i++
			}
			continue
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
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

// stripEchoedCommand drops a line that is only the typed command (leftover
// echo if a login rc turned ECHO back on before we re-apply master termios).
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
	ls.rawOut = appendCappedRaw(ls.rawOut, chunk)
	if scanPrompt(ls.rawOut) {
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

func beginLiveIO(ls *liveShell, ptyMaster io.Reader, readyCh chan struct{}) {
	go drainLive(ptyMaster, func(chunk []byte) {
		ls.feedScreen(chunk)
		s := string(chunk)
		if ls.ingestReady(s, readyCh) {
			return
		}
		ls.mu.Lock()
		cb := ls.onStdout
		ls.mu.Unlock()
		if cb != nil {
			cb(s)
		}
	}, func() { ls.markExit() })
}

func (ls *liveShell) feedScreen(p []byte) {
	if ls == nil || ls.screen == nil {
		return
	}
	ls.mu.Lock()
	idle := ls.screenIdle
	ls.mu.Unlock()
	if idle {
		return
	}
	ls.screen.write(p)
}

func liveSetupCommand() string {
	// No stty: tcsetattr from a non-foreground slave job gets SIGTTOU
	// even when tostop is off, and the stopped stty blocks exit.
	return "export TERM=xterm-256color; " +
		"bind 'set enable-bracketed-paste off' 2>/dev/null || true; " +
		"shopt -s expand_aliases 2>/dev/null || true; " +
		"setopt aliases 2>/dev/null || true; " +
		"unset PROMPT_COMMAND; PROMPT_COMMAND=; " +
		"precmd() { :; }; " +
		"PS1='" + promptPrefix + "$?\\n'; " +
		"PROMPT=$'" + promptPrefix + "%?\\n'\n"
}

func waitLiveReady(ls *liveShell, stdin io.Writer, readyCh <-chan struct{}) {
	// One compound command so bash/zsh print a single completion prompt.
	// bash: \n in PS1 is a prompt escape. zsh: PROMPT=$'...%?\n'.
	_, _ = io.WriteString(stdin, liveSetupCommand())
	select {
	case <-readyCh:
	case <-time.After(shellReadyWait):
		ls.mu.Lock()
		ls.ready = true
		ls.rawOut = ""
		ls.rawErr = ""
		ls.mu.Unlock()
	}
	// Login rc often turns echo back on; re-apply from the master.
	if f, ok := stdin.(*os.File); ok {
		disableMasterEcho(f)
	}
	// Drop a trailing extra prompt before the first run is written.
	time.Sleep(50 * time.Millisecond)
	ls.mu.Lock()
	ls.rawOut = ""
	ls.rawErr = ""
	ls.mu.Unlock()
}

func drainLive(r io.Reader, onChunk func([]byte), onEOF func()) {
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 && onChunk != nil {
			onChunk(append([]byte(nil), buf[:n]...))
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
	return ls.writeBytes([]byte(s))
}

func (ls *liveShell) writeBytes(p []byte) error {
	if ls == nil || ls.stdin == nil {
		return io.ErrClosedPipe
	}
	ls.writeMu.Lock()
	defer ls.writeMu.Unlock()
	_, err := ls.stdin.Write(p)
	return err
}

func (ls *liveShell) Write(p []byte) (int, error) {
	if err := ls.writeBytes(p); err != nil {
		return 0, err
	}
	return len(p), nil
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
		killLiveProcess(cmd.Process)
	}
}

func (s *supervisor) enqueueLive(corr, command string) (*pane, error) {
	return s.enqueueLiveFor("", corr, command)
}

func (s *supervisor) enqueueLiveFor(fingerprint, corr, command string) (*pane, error) {
	p := &pane{
		id:          "pane-" + corr,
		corr:        corr,
		command:     command,
		fingerprint: fingerprint,
		running:     true,
		lines:       []string{""},
		stdout:      newStreamBuf(),
		stderr:      newStreamBuf(),
	}
	s.mu.Lock()
	s.panes[p.id] = p
	if corr != "" {
		s.panes[corr] = p
	}
	s.order = append(s.order, p.id)
	sl := s.slotLocked(fingerprint)
	sl.queue = append(sl.queue, &liveJob{pane: p, command: command, fingerprint: fingerprint})
	s.mu.Unlock()
	go s.pumpLive(fingerprint)
	return p, nil
}

func (s *supervisor) pumpLive(fp string) {
	s.mu.Lock()
	sl := s.slotLocked(fp)
	if sl.pumping {
		s.mu.Unlock()
		return
	}
	sl.pumping = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.slotLocked(fp).pumping = false
		s.mu.Unlock()
	}()

	for {
		s.mu.Lock()
		sl := s.slotLocked(fp)
		if sl.pending != nil {
			s.mu.Unlock()
			return
		}
		if len(sl.queue) == 0 {
			s.mu.Unlock()
			return
		}
		job := sl.queue[0]
		sl.queue = sl.queue[1:]
		s.mu.Unlock()

		if err := s.ensureLive(fp); err != nil {
			s.failLiveJob(job, err.Error())
			continue
		}
		if err := s.startLiveJob(fp, job); err != nil {
			s.failLiveJob(job, err.Error())
			continue
		}
		return
	}
}

func (s *supervisor) ensureLive(fp string) error {
	s.mu.Lock()
	sl := s.slotLocked(fp)
	live := sl.live
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
		sl := s.slotLocked(fp)
		sl.live = nil
		if fp == "" {
			s.live = nil
		}
		s.mu.Unlock()
		return err
	}
	next.onStdout = func(chunk string) { s.onLiveStdout(fp, chunk) }
	next.onExit = func() { s.onLiveExit(fp) }
	time.Sleep(50 * time.Millisecond)
	s.mu.Lock()
	sl = s.slotLocked(fp)
	sl.live = next
	if fp == "" {
		s.live = next
	}
	s.mu.Unlock()
	return nil
}

func (s *supervisor) startLiveJob(fp string, job *liveJob) error {
	s.mu.Lock()
	live := s.slotLocked(fp).live
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
	live.screenIdle = false
	live.mu.Unlock()
	if job.pane != nil {
		job.pane.mu.Lock()
		job.pane.typed = false
		job.pane.mu.Unlock()
	}
	if live.screen != nil {
		live.screen.resetPrimary()
	}
	s.mu.Lock()
	s.slotLocked(fp).pending = job
	if live.stdin != nil {
		job.pane.mu.Lock()
		job.pane.stdin = live.stdin
		job.pane.mu.Unlock()
	}
	s.mu.Unlock()
	// Only the user command. Completion is the PS1 prompt, not a printf on stdin.
	if err := live.write(cmd); err != nil {
		s.mu.Lock()
		if s.slotLocked(fp).pending == job {
			s.slotLocked(fp).pending = nil
		}
		s.mu.Unlock()
		return err
	}
	go s.watchLiveJob(fp, job, live)
	if _, isExit := exitCommandCode(job.command); isExit {
		go func() {
			deadline := time.Now().Add(1500 * time.Millisecond)
			for time.Now().Before(deadline) && job.pane.stillRunning() {
				time.Sleep(20 * time.Millisecond)
			}
			// "exit" can return a prompt while the shell stays alive
			// ("There are stopped jobs"). Always reap the group so the
			// next run is a fresh login shell in $HOME.
			if live.alive() {
				live.kill()
			}
		}()
	}
	return nil
}

func (s *supervisor) onLiveStdout(fp, chunk string) {
	s.feedLive(fp, chunk)
}

// feedLive records PTY output (stdout+stderr on one pts) and completes
// when PS1 reappears. MCP error stays empty for command output.
func (s *supervisor) feedLive(fp, chunk string) {
	s.mu.Lock()
	sl := s.slotLocked(fp)
	job := sl.pending
	live := sl.live
	s.mu.Unlock()
	if job == nil || live == nil {
		return
	}
	live.mu.Lock()
	live.rawOut = appendCappedRaw(live.rawOut, chunk)
	live.mu.Unlock()
	if s.tryFinishLive(fp, job, live, false) {
		return
	}
	cleaned := stripCompletionText(chunk)
	if cleaned != "" {
		job.pane.append("stdout", cleaned)
	}
}

// tryFinishLive completes the pending corr when the live shell is back at
// PS1 (raw or CSI-stripped, or the VT grid) or when force is set (child
// died and the stream went quiet — ssh-pty-mcp / mcp-ssh-terminal).
func (s *supervisor) tryFinishLive(fp string, job *liveJob, live *liveShell, force bool) bool {
	if job == nil || live == nil {
		return false
	}
	live.mu.Lock()
	if job.finishing {
		live.mu.Unlock()
		return true
	}
	if !force && !scanPrompt(live.rawOut) {
		live.mu.Unlock()
		return false
	}
	out, rest, code, ok := parsePrompt(live.rawOut)
	if !ok && !force {
		live.mu.Unlock()
		return false
	}
	replay := rawOutputBeforePrompt(live.rawOut)
	if !ok {
		out = live.rawOut
		rest = ""
		code = 0
		replay = live.rawOut
	}
	usedAlt := live.screen != nil && live.screen.altUsed()
	answered := live.screen != nil && live.screen.answered()
	job.finishing = true
	live.rawOut = rest
	live.lastUsed = time.Now()
	live.screenIdle = true
	live.mu.Unlock()

	typed := false
	if job.pane != nil {
		job.pane.mu.Lock()
		typed = job.pane.typed
		job.pane.mu.Unlock()
	}

	s.mu.Lock()
	if s.slotLocked(fp).pending == job {
		s.slotLocked(fp).pending = nil
	}
	s.mu.Unlock()

	out = stripEchoedCommand(stripCompletionText(out), job.command)
	if live.screen != nil {
		live.screen.resetPrimary()
		if replayAfterFinish(ok, force, usedAlt, answered, typed) {
			live.screen.replay([]byte(replay))
		}
	}
	if !keepCommandStdout(ok, force, usedAlt, answered, typed, out) {
		out = ""
		if live.screen != nil {
			out, _, _ = live.screen.grid()
		}
	}
	job.pane.finishCommand(out, code)
	job.pane.mu.Lock()
	job.pane.stderr = newStreamBuf()
	job.pane.mu.Unlock()
	if _, isExit := exitCommandCode(job.command); isExit && live.alive() {
		live.kill()
	}
	go s.pumpLive(fp)
	return true
}

func (s *supervisor) watchLiveJob(fp string, job *liveJob, live *liveShell) {
	if job == nil || live == nil {
		return
	}
	shellPgid := 0
	if live.cmd != nil && live.cmd.Process != nil {
		shellPgid = live.cmd.Process.Pid
	}
	sawChild := false
	var quietAt time.Time
	lastRaw := ""
	for job.pane.stillRunning() && live.alive() {
		if s.tryFinishLive(fp, job, live, false) {
			return
		}
		pgid := foregroundPgid(live.stdin)
		if pgid > 1 && shellPgid > 0 && pgid != shellPgid {
			sawChild = true
			quietAt = time.Time{}
		}
		live.mu.Lock()
		raw := live.rawOut
		live.mu.Unlock()
		backAtShell := sawChild && (pgid == shellPgid || pgid <= 1)
		if backAtShell {
			if raw != lastRaw || quietAt.IsZero() {
				lastRaw = raw
				quietAt = time.Now()
			} else if time.Since(quietAt) >= childQuietFor {
				s.tryFinishLive(fp, job, live, true)
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (s *supervisor) onLiveExit(fp string) {
	s.mu.Lock()
	sl := s.slotLocked(fp)
	job := sl.pending
	sl.pending = nil
	sl.live = nil
	if fp == "" {
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
	go s.pumpLive(fp)
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
