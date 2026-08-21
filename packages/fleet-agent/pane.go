package main

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
	screenInterval = 250 * time.Millisecond
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

type pane struct {
	id, corr, command string
	mu                sync.Mutex
	lines             []string
	stdout            *streamBuf
	stderr            *streamBuf
	running           bool
	exitCode          int
	seq               int
	stdin             io.WriteCloser
	cmd               *exec.Cmd
	dirty             bool
}

type supervisor struct {
	mu      sync.Mutex
	panes   map[string]*pane
	order   []string
	live    *liveShell
	pending *liveJob
	queue   []*liveJob
	pumping bool
}

func newSupervisor() *supervisor {
	return &supervisor{panes: map[string]*pane{}}
}

func (s *supervisor) spawn(corr, command string) (*pane, error) {
	if runtime.GOOS != "windows" {
		return s.enqueueLive(corr, command)
	}
	return s.spawnOneshot(corr, command)
}

func (s *supervisor) spawnOneshot(corr, command string) (*pane, error) {
	ctx := context.Background()
	cmd := exec.CommandContext(ctx, "cmd", "/C", command)
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
	p := &pane{
		id:      "pane-" + corr,
		corr:    corr,
		command: command,
		running: true,
		stdin:   stdin,
		cmd:     cmd,
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

func drain(p *pane, r io.Reader, which string) {
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

func (p *pane) append(which, chunk string) {
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

func (p *pane) appendDisplayLocked(chunk string) {
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

func (p *pane) snapshot() (text string, running bool, code int, seq int) {
	text, running, code, seq, _, _ = p.snapshotFrame()
	return
}

func (p *pane) snapshotFrame() (text string, running bool, code, seq, row, col int) {
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

func (s *supervisor) paneSnapshot(p *pane) (text string, running bool, code, seq, row, col int) {
	if p == nil {
		return "", false, 0, 0, 0, 0
	}
	s.mu.Lock()
	live := s.live
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
	return p.snapshotFrame()
}

func (p *pane) resultText() (stdout, stderr string) {
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

func (p *pane) typeKeys(keys string) error {
	return p.typeInput(keys, "")
}

func (p *pane) typeInput(keys, named string) error {
	p.mu.Lock()
	w := p.stdin
	oneshot := p.cmd != nil
	alive := p.running
	p.mu.Unlock()
	if w == nil {
		return io.ErrClosedPipe
	}
	if oneshot && !alive {
		return io.ErrClosedPipe
	}
	if oneshot {
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
		if _, err := w.Write(stroke.payload); err != nil {
			return err
		}
	}
	signalForeground(w, stroke.sigint, stroke.sigquit)
	return nil
}

func (s *supervisor) get(id string) *pane {
	s.mu.Lock()
	defer s.mu.Unlock()
	var p *pane
	if id == "" {
		if len(s.order) == 0 {
			return nil
		}
		p = s.panes[s.order[len(s.order)-1]]
	} else {
		p = s.panes[id]
	}
	if p != nil && s.live != nil && s.live.stdin != nil {
		p.mu.Lock()
		p.stdin = s.live.stdin
		p.mu.Unlock()
	}
	return p
}

func (s *supervisor) list() []map[string]any {
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

func (s *supervisor) takeDirty() *pane {
	s.mu.Lock()
	defer s.mu.Unlock()
	var latest *pane
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
