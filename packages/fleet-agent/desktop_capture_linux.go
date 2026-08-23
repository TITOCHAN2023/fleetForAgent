//go:build linux

package main

import (
	"bytes"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"os/exec"
	"strings"
	"time"
)

func runBounded(cmd *exec.Cmd, d time.Duration) error {
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-time.After(d):
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		<-done
		return fmt.Errorf("timeout")
	}
}

func desktopSupported() bool { return true }

func linuxHasDisplay() bool {
	return os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != ""
}

func nativeCapture() (*image.RGBA, DisplayInfo, error) {
	desk := os.Getenv("XDG_CURRENT_DESKTOP")
	if !linuxHasDisplay() {
		return nil, DisplayInfo{}, desktopError{
			code: "no_session",
			msg:  "fleet: no graphical session (" + desk + ")",
		}
	}
	img, err := linuxGrab()
	if err != nil {
		return nil, DisplayInfo{}, err
	}
	b := img.Bounds()
	return toRGBA(img), DisplayInfo{ID: "primary", Width: b.Dx(), Height: b.Dy(), Scale: 1}, nil
}

func linuxGrab() (image.Image, error) {
	try := [][]string{
		{"grim", "-"},
		{"import", "-window", "root", "png:-"},
	}
	var last error
	for _, args := range try {
		if _, err := exec.LookPath(args[0]); err != nil {
			last = err
			continue
		}
		cmd := exec.Command(args[0], args[1:]...)
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		if err := runBounded(cmd, 3*time.Second); err != nil {
			last = fmt.Errorf("%s: %v %s", args[0], err, strings.TrimSpace(stderr.String()))
			continue
		}
		img, _, err := image.Decode(&stdout)
		if err != nil {
			last = err
			continue
		}
		return img, nil
	}
	f, err := os.CreateTemp("", "fleet-desk-*.png")
	if err != nil {
		return nil, desktopError{code: "capture_failed", msg: "fleet: temp file: " + err.Error()}
	}
	tmp := f.Name()
	_ = f.Close()
	defer os.Remove(tmp)
	_ = os.Chmod(tmp, 0o600)
	fileTry := [][]string{
		{"scrot", "-z", tmp},
		{"gnome-screenshot", "-f", tmp},
	}
	for _, args := range fileTry {
		if _, err := exec.LookPath(args[0]); err != nil {
			last = err
			continue
		}
		cmd := exec.Command(args[0], args[1:]...)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if err := runBounded(cmd, 3*time.Second); err != nil {
			last = fmt.Errorf("%s: %v %s", args[0], err, strings.TrimSpace(stderr.String()))
			continue
		}
		rf, err := os.Open(tmp)
		if err != nil {
			last = err
			continue
		}
		img, _, err := image.Decode(rf)
		_ = rf.Close()
		if err != nil {
			last = err
			continue
		}
		return img, nil
	}
	if last == nil {
		last = fmt.Errorf("no grim/import/scrot")
	}
	return nil, desktopError{code: "os_permission", msg: "fleet: screenshot backend failed (" + deskEnv() + "): " + last.Error(), permission: "screenshot"}
}

func deskEnv() string {
	return strings.TrimSpace(os.Getenv("XDG_CURRENT_DESKTOP") + " " + os.Getenv("WAYLAND_DISPLAY") + " " + os.Getenv("DISPLAY"))
}

func nativeScroll(x, y, dx, dy int) error {
	if err := pointerMoveAt(x, y); err != nil {
		return err
	}
	p, _ := nativePointer()
	lp, ok := p.(*linuxPointer)
	if !ok || lp == nil {
		return desktopError{code: "no_input_backend", msg: "no_input_backend"}
	}
	// xdotool: 4=up 5=down 6=left 7=right
	n := dy
	btn := 5
	if n < 0 {
		n = -n
		btn = 4
	}
	for i := 0; i < n; i++ {
		if err := lp.cmd(fmt.Sprintf("click %d", btn)); err != nil {
			return err
		}
	}
	n = dx
	btn = 7
	if n < 0 {
		n = -n
		btn = 6
	}
	for i := 0; i < n; i++ {
		if err := lp.cmd(fmt.Sprintf("click %d", btn)); err != nil {
			return err
		}
	}
	return nil
}

func nativeTypeText(text string) error {
	p, _ := nativePointer()
	lp, ok := p.(*linuxPointer)
	if !ok || lp == nil {
		return desktopError{code: "no_input_backend", msg: "no_input_backend"}
	}
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if line != "" {
			if err := lp.cmd("type -- " + line); err != nil {
				return err
			}
		}
		if i < len(lines)-1 {
			if err := lp.cmd("key Return"); err != nil {
				return err
			}
		}
	}
	return nil
}

func nativeKey(spec string) error {
	p, _ := nativePointer()
	lp, ok := p.(*linuxPointer)
	if !ok || lp == nil {
		return desktopError{code: "no_input_backend", msg: "no_input_backend"}
	}
	names := splitKeySpec(spec)
	if len(names) == 0 {
		return desktopError{code: "bad_request", msg: "fleet: unknown key"}
	}
	mapped := make([]string, len(names))
	for i, n := range names {
		switch n {
		case "win":
			mapped[i] = "super"
		case "escape":
			mapped[i] = "Escape"
		case "enter":
			mapped[i] = "Return"
		default:
			mapped[i] = n
		}
	}
	return lp.cmd("key -- " + strings.Join(mapped, "+"))
}
