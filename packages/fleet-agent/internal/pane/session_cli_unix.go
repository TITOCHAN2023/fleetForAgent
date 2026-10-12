//go:build linux || darwin || freebsd || netbsd || openbsd

package pane

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/TITOCHAN2023/fleetForAgent/internal/pane/backend"
	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

// SessionCLI exposes mux sessions through the existing run/type/read_screen
// transport: run `fleet session NAME`, then type into that run's PTY. No prompt
// parsing or command injection into a surviving foreground program is needed.
func SessionCLI(args []string) error {
	closeSession := len(args) == 2 && args[0] == "close"
	if closeSession {
		args = args[1:]
	}
	if len(args) != 1 || args[0] == "" {
		return fmt.Errorf("usage: fleet session [close] NAME (Ctrl+] detaches)")
	}
	home := os.Getenv("FLEET_HOME")
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	sum := sha256.Sum256([]byte(home + "\x00" + os.Getenv("FLEET_SESSION_OWNER") + "\x00" + args[0]))
	name := fmt.Sprintf("flt-%x", sum[:16])
	t := backend.Requested()
	if closeSession {
		if t == backend.TypePTY {
			return fmt.Errorf("pty does not support closing sessions by name; terminate the owning run instead")
		}
		backend.DestroySession(t, name)
		if probe := backend.ProbeSession(t, name); probe != backend.ProbeMissing {
			return fmt.Errorf("session close not confirmed: %s", probe)
		}
		return nil
	}
	// Fleet type sends both the control byte and a signal to this outer PTY.
	// The byte is forwarded to the inner terminal; consuming the duplicate
	// signal keeps the viewer alive without interrupting the command twice.
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, syscall.SIGINT, syscall.SIGQUIT)
	defer signal.Stop(interrupt)
	fd := int(os.Stdin.Fd())
	state, err := unix.IoctlGetTermios(fd, ioctlReadTermios)
	if err != nil {
		return fmt.Errorf("session requires a terminal (use Fleet run): %w", err)
	}
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	opts := backend.SpawnOpts{Bin: pickShell(), Args: []string{"-il"}, Cwd: cwd, Env: os.Environ(), Cols: livePtyCols, Rows: livePtyRows}
	if size, err := pty.GetsizeFull(os.Stdin); err == nil {
		opts.Cols = size.Cols
		opts.Rows = size.Rows
	}
	h, err := backend.OpenType(t, name, opts)
	if err != nil {
		return err
	}
	defer h.Detach()
	raw := *state
	raw.Iflag &^= unix.IGNBRK | unix.BRKINT | unix.PARMRK | unix.ISTRIP | unix.INLCR | unix.IGNCR | unix.ICRNL | unix.IXON
	raw.Oflag &^= unix.OPOST
	raw.Lflag &^= unix.ECHO | unix.ECHONL | unix.ICANON | unix.ISIG | unix.IEXTEN
	raw.Cflag &^= unix.CSIZE | unix.PARENB
	raw.Cflag |= unix.CS8
	raw.Cc[unix.VMIN] = 1
	raw.Cc[unix.VTIME] = 0
	if err := unix.IoctlSetTermios(fd, ioctlWriteTermios, &raw); err != nil {
		return err
	}
	defer unix.IoctlSetTermios(fd, ioctlWriteTermios, state)
	resize := make(chan os.Signal, 1)
	signal.Notify(resize, syscall.SIGWINCH)
	defer signal.Stop(resize)
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGHUP, syscall.SIGTERM)
	defer signal.Stop(stop)
	inputDone := make(chan struct{})
	go func() {
		defer close(inputDone)
		buf := make([]byte, 4096)
		for {
			n, err := os.Stdin.Read(buf)
			chunk := buf[:n]
			detach := bytes.IndexByte(chunk, 0x1d)
			if detach >= 0 {
				chunk = chunk[:detach]
			}
			if len(chunk) > 0 {
				if _, writeErr := h.File.Write(chunk); writeErr != nil {
					return
				}
			}
			if err != nil || detach >= 0 {
				return
			}
		}
	}()
	outputDone := make(chan struct{})
	go func() { _, _ = io.Copy(os.Stdout, h.File); close(outputDone) }()
	exited := make(chan error, 1)
	go func() { exited <- h.Cmd.Wait() }()
	for {
		select {
		case <-inputDone:
			return nil
		case <-interrupt:
			// Input forwarding delivers Ctrl+C / Ctrl+\ to the inner PTY.
		case <-stop:
			return nil
		case err := <-exited:
			<-outputDone
			return err
		case <-resize:
			_ = pty.InheritSize(os.Stdin, h.File)
		}
	}
}
