//go:build !windows

package backend

import (
	"os"
	"strings"
	"testing"
	"time"
)

// Run in the disposable intranet lab, never against a user's Herdr instance.
func TestHerdrLifecycle(t *testing.T) {
	if os.Getenv("FLEET_HERDR_TEST") != "1" {
		t.Skip("requires disposable Herdr lab")
	}
	t.Setenv("FLEET_HOME", t.TempDir())
	t.Setenv("TERM", "xterm-256color")
	opts := SpawnOpts{Bin: "/bin/sh", Args: []string{"-i"}, Cwd: "/tmp", Env: os.Environ(), Cols: 100, Rows: 30}
	name := "lifecycle"
	h, err := OpenType(TypeHerdr, name, opts)
	if err != nil {
		t.Fatal(err)
	}
	defer DestroySession(TypeHerdr, name)
	read := func(h *Handle) <-chan string {
		ch := make(chan string, 256)
		go func() {
			defer close(ch)
			b := make([]byte, 8192)
			for {
				n, e := h.File.Read(b)
				if n > 0 {
					ch <- string(b[:n])
				}
				if e != nil {
					return
				}
			}
		}()
		return ch
	}
	await := func(ch <-chan string, want string) {
		t.Helper()
		out := ""
		timer := time.NewTimer(10 * time.Second)
		defer timer.Stop()
		for {
			select {
			case s, ok := <-ch:
				out += s
				if strings.Contains(out, want) {
					return
				}
				if !ok {
					t.Fatalf("stream ended waiting for %q: %q", want, out)
				}
			case <-timer.C:
				t.Fatalf("timeout waiting for %q: %q", want, out)
			}
		}
	}
	ch := read(h)
	// The expected string never occurs in the echoed command.
	_, _ = h.File.Write([]byte("FLEET_TEST_VALUE=survived; printf 'first%s\\n' '-ready'\r"))
	await(ch, "first-ready")
	h.Detach()
	_ = h.Cmd.Wait()
	if got := ProbeSession(TypeHerdr, name); got != ProbeExists {
		t.Fatalf("detached session: %s", got)
	}
	next, err := OpenType(TypeHerdr, name, opts)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Destroy()
	if !next.Reattach {
		t.Fatal("created instead of reattached")
	}
	ch = read(next)
	_, _ = next.File.Write([]byte("printf 'value:%s\\n' \"$FLEET_TEST_VALUE\"\r"))
	await(ch, "value:survived")
	next.Destroy()
	_ = next.Cmd.Wait()
	if got := ProbeSession(TypeHerdr, name); got != ProbeMissing {
		t.Fatalf("destroyed session: %s", got)
	}
	// Explicit close must discard Herdr's saved layout rather than create
	// a second terminal alongside a restored shell.
	fresh, err := OpenType(TypeHerdr, name, opts)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Reattach {
		t.Fatal("closed session was restored")
	}
	fresh.Destroy()
	_ = fresh.Cmd.Wait()
}

func TestHerdrEnvIsolation(t *testing.T) {
	env := herdrEnv("test", []string{"HOME=/home/test", "HERDR_SOCKET_PATH=/other", "HERDR_SESSION=personal", "XDG_CONFIG_HOME=/personal", "TERM=xterm"})
	joined := strings.Join(env, "\n")
	for _, bad := range []string{"/other", "personal"} {
		if strings.Contains(joined, bad) {
			t.Fatalf("inherited Herdr routing: %s", joined)
		}
	}
	if !strings.Contains(joined, "HOME=/home/test") {
		t.Fatal("lost child home")
	}
}
