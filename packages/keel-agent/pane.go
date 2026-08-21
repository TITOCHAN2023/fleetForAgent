package main

import (
	"bufio"
	"context"
	"io"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	screenInterval = 250 * time.Millisecond
	ringLines      = 200
	screenLines    = 80
)

type pane struct {
	id, corr, command string
	mu                sync.Mutex
	lines             []string
	running           bool
	exitCode          int
	seq               int
	stdin             io.WriteCloser
	cmd               *exec.Cmd
	dirty             bool
}

type supervisor struct {
	mu    sync.Mutex
	panes map[string]*pane
	order []string
}

func newSupervisor() *supervisor {
	return &supervisor{panes: map[string]*pane{}}
}

func (s *supervisor) spawn(corr, command string) (*pane, error) {
	ctx := context.Background()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "cmd", "/C", command)
	} else {
		cmd = exec.CommandContext(ctx, "/bin/sh", "-c", command)
	}
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
	}
	s.mu.Lock()
	s.panes[p.id] = p
	if corr != "" {
		s.panes[corr] = p
	}
	s.order = append(s.order, p.id)
	s.mu.Unlock()
	go drain(p, stdout)
	go drain(p, stderr)
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

func drain(p *pane, r io.Reader) {
	br := bufio.NewReader(r)
	buf := make([]byte, 4096)
	for {
		n, err := br.Read(buf)
		if n > 0 {
			p.append(string(buf[:n]))
		}
		if err != nil {
			return
		}
	}
}

func (p *pane) append(chunk string) {
	p.mu.Lock()
	defer p.mu.Unlock()
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
	p.dirty = true
}

func (p *pane) snapshot() (text string, running bool, code int, seq int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.seq++
	start := 0
	if len(p.lines) > screenLines {
		start = len(p.lines) - screenLines
	}
	text = strings.Join(p.lines[start:], "\n")
	p.dirty = false
	return text, p.running, p.exitCode, p.seq
}

func (p *pane) typeKeys(keys string) error {
	p.mu.Lock()
	w := p.stdin
	alive := p.running
	p.mu.Unlock()
	if !alive || w == nil {
		return io.ErrClosedPipe
	}
	_, err := io.WriteString(w, keys)
	return err
}

func (s *supervisor) get(id string) *pane {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id == "" {
		if len(s.order) == 0 {
			return nil
		}
		return s.panes[s.order[len(s.order)-1]]
	}
	return s.panes[id]
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
