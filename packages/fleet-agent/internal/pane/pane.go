package pane

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	ScreenInterval = 250 * time.Millisecond
	ringLines      = 200
	headLines      = 200
	screenLines    = 80
)

type streamBuf struct {
	head     []string
	tail     []string
	current  string
	headDone bool
	dropped  int
}

func newStreamBuf() *streamBuf {
	return &streamBuf{}
}

func (s *streamBuf) append(chunk string) {
	chunk = strings.ReplaceAll(chunk, "\r", "")
	if !utf8.ValidString(chunk) {
		chunk = strings.ToValidUTF8(chunk, "\uFFFD")
	}
	parts := strings.Split(chunk, "\n")
	s.current += parts[0]
	for _, rest := range parts[1:] {
		s.pushCompleted(s.current)
		s.current = rest
	}
}

func (s *streamBuf) pushCompleted(line string) {
	if !s.headDone {
		s.head = append(s.head, line)
		if len(s.head) >= headLines {
			s.headDone = true
		}
		return
	}
	s.tail = append(s.tail, line)
	if len(s.tail) > ringLines {
		s.dropped++
		s.tail = s.tail[1:]
	}
}

func (s *streamBuf) render() string {
	parts := append([]string{}, s.head...)
	if s.headDone {
		if s.dropped > 0 {
			parts = append(parts, "", fmt.Sprintf("[... %d lines omitted ...]", s.dropped), "")
		}
		parts = append(parts, s.tail...)
	}
	if s.current != "" {
		parts = append(parts, s.current)
	}
	return strings.Join(parts, "\n")
}

type Pane struct {
	id, corr, command string
	fingerprint       string
	mu                sync.Mutex
	lines             []string
	stdout            *streamBuf
	stderr            *streamBuf
	running           bool
	typed             bool
	exitCode          int
	seq               int
	stdin             io.WriteCloser
	cmd               *exec.Cmd
	screen            *vtScreen
	rawOut            string
	dirty             bool
}

type liveSlot struct {
	live    *liveShell
	pending *liveJob
	queue   []*liveJob
	pumping bool
}

type Supervisor struct {
	mu    sync.Mutex
	panes map[string]*Pane
	order []string
	// live is the anonymous (empty fingerprint) slot. Tests and 0.2.7 hubs.
	live  *liveShell
	slots map[string]*liveSlot
}

func NewSupervisor() *Supervisor {
	return &Supervisor{panes: map[string]*Pane{}}
}

func (p *Pane) ID() string   { return p.id }
func (p *Pane) Corr() string { return p.corr }

func (p *Pane) ProcessPID() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cmd != nil && p.cmd.Process != nil {
		return p.cmd.Process.Pid
	}
	return 0
}

func (p *Pane) Typable() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.running && p.stdin != nil
}

func (p *Pane) Finished() (done bool, code int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return !p.running, p.exitCode
}

func (s *Supervisor) spawn(corr, command string) (*Pane, error) {
	return s.SpawnFor("", corr, command)
}

func (s *Supervisor) SpawnFor(fingerprint, corr, command string) (*Pane, error) {
	// Each run is its own process (shell -c / cmd /C). Completion is the
	// child exit code, not PS1 on a shared interactive login PTY.
	if runtime.GOOS != "windows" {
		return s.spawnOneshotPTY(fingerprint, corr, command)
	}
	return s.spawnOneshotFor(fingerprint, corr, command)
}

func (s *Supervisor) spawnOneshot(corr, command string) (*Pane, error) {
	return s.spawnOneshotFor("", corr, command)
}

func (s *Supervisor) slotLocked(fp string) *liveSlot {
	if s.slots == nil {
		s.slots = map[string]*liveSlot{}
	}
	sl := s.slots[fp]
	if sl == nil {
		sl = &liveSlot{}
		s.slots[fp] = sl
		if fp == "" {
			sl.live = s.live
		}
	}
	return sl
}

func (s *Supervisor) LiveFor(fp string) *liveShell {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.slotLocked(fp).live
}

func (s *Supervisor) KillAllLive() {
	s.mu.Lock()
	if s.live != nil {
		s.live.kill()
	}
	for _, sl := range s.slots {
		if sl.live != nil {
			sl.live.kill()
		}
	}
	var procs []*exec.Cmd
	for _, p := range s.panes {
		if p == nil {
			continue
		}
		p.mu.Lock()
		if p.cmd != nil && p.cmd.Process != nil {
			procs = append(procs, p.cmd)
		}
		p.mu.Unlock()
	}
	s.mu.Unlock()
	for _, cmd := range procs {
		killLiveProcess(cmd.Process)
	}
}

func (s *Supervisor) Busy() bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.panes {
		if p != nil && p.StillRunning() {
			return true
		}
	}
	if s.live != nil && s.live.alive() && !s.live.idleExpired() {
		return true
	}
	for _, sl := range s.slots {
		if sl == nil {
			continue
		}
		if sl.pending != nil {
			return true
		}
		if sl.live != nil && sl.live.alive() && !sl.live.idleExpired() {
			return true
		}
	}
	return false
}

func (s *Supervisor) spawnOneshotFor(fingerprint, corr, command string) (*Pane, error) {
	ctx := context.Background()
	cmd := exec.CommandContext(ctx, "cmd", "/C", command)
	cmd.Env = runCommandEnv()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	p := &Pane{
		id:          "pane-" + corr,
		corr:        corr,
		command:     command,
		fingerprint: fingerprint,
		running:     true,
		stdin:       stdin,
		cmd:         cmd,
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
	s.mu.Unlock()
	go drain(p, stdout, "stdout")
	go drain(p, stderr, "stderr")
	go func() {
		err := cmd.Wait()
		code := 0
		if err != nil {
			code = 1
			if ee, ok := err.(*exec.ExitError); ok {
				code = ee.ExitCode()
			}
		}
		p.mu.Lock()
		p.running = false
		p.exitCode = code
		p.dirty = true
		p.mu.Unlock()
		_ = stdin.Close()
	}()
	return p, nil
}

func drain(p *Pane, r io.Reader, which string) {
	br := bufio.NewReader(r)
	buf := make([]byte, 4096)
	for {
		n, err := br.Read(buf)
		if n > 0 {
			p.append(which, string(buf[:n]))
		}
		if err != nil {
			return
		}
	}
}

func (p *Pane) append(which, chunk string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.appendDisplayLocked(chunk)
	if p.stdout == nil {
		p.stdout = newStreamBuf()
	}
	if p.stderr == nil {
		p.stderr = newStreamBuf()
	}
	if which == "stderr" {
		p.stderr.append(chunk)
	} else {
		p.stdout.append(chunk)
	}
	p.dirty = true
}

func (p *Pane) appendDisplayLocked(chunk string) {
	chunk = strings.ReplaceAll(chunk, "\r", "")
	parts := strings.Split(chunk, "\n")
	if len(p.lines) == 0 {
		p.lines = []string{""}
	}
	p.lines[len(p.lines)-1] += parts[0]
	p.lines = append(p.lines, parts[1:]...)
	if len(p.lines) > ringLines {
		p.lines = p.lines[len(p.lines)-ringLines:]
	}
}

func (p *Pane) snapshot() (text string, running bool, code int, seq int) {
	text, running, code, seq, _, _ = p.SnapshotFrame()
	return
}

func (p *Pane) SnapshotFrame() (text string, running bool, code, seq, row, col int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.seq++
	start := 0
	if len(p.lines) > screenLines {
		start = len(p.lines) - screenLines
	}
	text = strings.Join(p.lines[start:], "\n")
	p.dirty = false
	return text, p.running, p.exitCode, p.seq, 0, 0
}

func (s *Supervisor) PaneSnapshot(p *Pane) (text string, running bool, code, seq, row, col int) {
	if p == nil {
		return "", false, 0, 0, 0, 0
	}
	if p.screen != nil {
		text, row, col = p.screen.grid()
		p.mu.Lock()
		p.seq++
		running, code, seq = p.running, p.exitCode, p.seq
		p.dirty = false
		p.mu.Unlock()
		return
	}
	s.mu.Lock()
	live := s.slotLocked(p.fingerprint).live
	s.mu.Unlock()
	if live != nil && live.screen != nil {
		text, row, col = live.screen.grid()
		p.mu.Lock()
		p.seq++
		running, code, seq = p.running, p.exitCode, p.seq
		p.dirty = false
		p.mu.Unlock()
		return
	}
	return p.SnapshotFrame()
}

func (p *Pane) ResultText() (stdout, stderr string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stdout == nil {
		p.stdout = newStreamBuf()
	}
	if p.stderr == nil {
		p.stderr = newStreamBuf()
	}
	return p.stdout.render(), p.stderr.render()
}

func (p *Pane) TypeKeys(keys string) error {
	return p.TypeInput(keys, "")
}

func (p *Pane) TypeInput(keys, named string) error {
	p.mu.Lock()
	w := p.stdin
	pipeOneshot := p.cmd != nil && p.screen == nil
	alive := p.running
	if !pipeOneshot && alive {
		p.typed = true
	}
	p.mu.Unlock()
	if w == nil {
		return io.ErrClosedPipe
	}
	if pipeOneshot && !alive {
		return io.ErrClosedPipe
	}
	if pipeOneshot {
		if strings.TrimSpace(named) != "" {
			stroke, err := encodeType("", named)
			if err != nil {
				return err
			}
			_, err = w.Write(stroke.payload)
			return err
		}
		_, err := io.WriteString(w, keys)
		return err
	}
	stroke, err := encodeType(keys, named)
	if err != nil {
		return err
	}
	if len(stroke.payload) > 0 {
		if err := writeTypedKeys(w, stroke.payload); err != nil {
			return err
		}
	}
	signalForeground(w, stroke.sigint, stroke.sigquit)
	return nil
}

func (s *Supervisor) get(id string) *Pane {
	return s.GetFor("", id)
}

func (s *Supervisor) GetFor(fingerprint, id string) *Pane {
	s.mu.Lock()
	defer s.mu.Unlock()
	var p *Pane
	if id == "" {
		for i := len(s.order) - 1; i >= 0; i-- {
			cand := s.panes[s.order[i]]
			if cand == nil {
				continue
			}
			if fingerprint == "" || cand.fingerprint == fingerprint {
				p = cand
				break
			}
		}
	} else {
		p = s.panes[id]
		if p != nil && fingerprint != "" && p.fingerprint != fingerprint {
			return nil
		}
	}
	if p != nil && p.cmd == nil {
		live := s.slotLocked(p.fingerprint).live
		if live != nil && live.stdin != nil {
			p.mu.Lock()
			p.stdin = live.stdin
			p.mu.Unlock()
		}
	}
	return p
}

func (s *Supervisor) List() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []map[string]any{}
	seen := map[string]bool{}
	for _, id := range s.order {
		p := s.panes[id]
		if p == nil || seen[p.id] {
			continue
		}
		seen[p.id] = true
		p.mu.Lock()
		out = append(out, map[string]any{
			"id": p.id, "corr": p.corr, "command": p.command, "running": p.running,
		})
		p.mu.Unlock()
	}
	return out
}

func (s *Supervisor) TakeDirty() *Pane {
	s.mu.Lock()
	defer s.mu.Unlock()
	var latest *Pane
	for _, id := range s.order {
		p := s.panes[id]
		if p == nil {
			continue
		}
		p.mu.Lock()
		if p.dirty {
			latest = p
		}
		p.mu.Unlock()
	}
	return latest
}
