//go:build linux

package desktop

import (
	"bufio"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"sync"
)

type linuxPointer struct {
	mu     sync.Mutex
	dotool *exec.Cmd
	w      *bufio.Writer
	held   bool
	x, y   float64
}

var (
	linuxHIDOnce sync.Once
	linuxPtr     *linuxPointer
)

func nativePointer() (pointerDevice, pointerOverlay) {
	linuxHIDOnce.Do(func() { linuxPtr = &linuxPointer{} })
	return linuxPtr, noopOverlay{}
}

func nativeMotionBounds() motionBounds {
	out, err := exec.Command("xdotool", "getdisplaygeometry").Output()
	if err == nil {
		var w, h int
		if _, scanErr := fmt.Sscanf(strings.TrimSpace(string(out)), "%dx%d", &w, &h); scanErr == nil && w > 1 && h > 1 {
			return motionBounds{0, 0, float64(w - 1), float64(h - 1)}
		}
	}
	return motionBounds{0, 0, 1919, 1079}
}

func (p *linuxPointer) resetLocked() {
	if p.dotool != nil && p.dotool.Process != nil {
		_ = p.dotool.Process.Kill()
		_, _ = p.dotool.Process.Wait()
	}
	p.dotool = nil
	p.w = nil
}

func (p *linuxPointer) ensure() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.w != nil {
		return nil
	}
	path, err := exec.LookPath("xdotool")
	if err != nil {
		return fmt.Errorf("no_input_backend: install xdotool")
	}
	cmd := exec.Command(path, "-")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	p.dotool = cmd
	p.w = bufio.NewWriter(stdin)
	return nil
}

func (p *linuxPointer) cmd(line string) error {
	if err := p.ensure(); err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.w == nil {
		return fmt.Errorf("no_input_backend: xdotool gone")
	}
	if _, err := p.w.WriteString(line + "\n"); err != nil {
		p.resetLocked()
		return err
	}
	if err := p.w.Flush(); err != nil {
		p.resetLocked()
		return err
	}
	return nil
}

func (p *linuxPointer) CursorPos() (float64, float64, error) {
	out, err := exec.Command("xdotool", "getmouselocation", "--shell").Output()
	if err != nil {
		return 0, 0, err
	}
	var x, y float64
	for _, line := range strings.Split(string(out), "\n") {
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		n, _ := strconv.ParseFloat(strings.TrimSpace(v), 64)
		switch k {
		case "X":
			x = n
		case "Y":
			y = n
		}
	}
	return x, y, nil
}

func (p *linuxPointer) MoveAbs(x, y float64) error {
	p.x, p.y = x, y
	return p.cmd(fmt.Sprintf("mousemove -- %d %d", int(x+0.5), int(y+0.5)))
}

func (p *linuxPointer) Button(button pointerButton, down bool) error {
	n := 1
	switch button {
	case pointerRight:
		n = 3
	case pointerMiddle:
		n = 2
	}
	if down {
		p.held = true
		return p.cmd(fmt.Sprintf("mousedown %d", n))
	}
	p.held = false
	return p.cmd(fmt.Sprintf("mouseup %d", n))
}
