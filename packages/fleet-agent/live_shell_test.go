package main

import (
	"runtime"
	"strings"
	"testing"
	"time"
)

func waitPaneDone(t *testing.T, p *pane) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !p.stillRunning() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("pane %s still running: %q", p.corr, p.command)
}

func TestParseDoneMarker(t *testing.T) {
	marker := "__MCP_DONE__abc-123__"
	out, rest, code, ok := parseDoneMarker("hello\n"+marker+"0\nmore\n", marker)
	if !ok {
		t.Fatal("expected marker")
	}
	if out != "hello\n" {
		t.Fatalf("output=%q", out)
	}
	if rest != "more\n" {
		t.Fatalf("rest=%q", rest)
	}
	if code != 0 {
		t.Fatalf("code=%d", code)
	}
	_, _, _, ok = parseDoneMarker("hello "+marker+"1", marker)
	if ok {
		t.Fatal("incomplete (no newline) must not parse")
	}
	out, _, code, ok = parseDoneMarker("oops\n"+marker+"7\n", marker)
	if !ok || code != 7 || out != "oops\n" {
		t.Fatalf("exit 7: ok=%v code=%d out=%q", ok, code, out)
	}
}

func TestLiveShellPersistsEnvAndCwd(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("live shell is POSIX-only")
	}
	s := newSupervisor()
	t.Cleanup(func() {
		s.mu.Lock()
		if s.live != nil {
			s.live.kill()
		}
		s.mu.Unlock()
	})

	p1, err := s.spawn("c1", "export FOO=bar")
	if err != nil {
		t.Fatal(err)
	}
	waitPaneDone(t, p1)

	p2, err := s.spawn("c2", `printf '%s' "$FOO"`)
	if err != nil {
		t.Fatal(err)
	}
	waitPaneDone(t, p2)
	out, stderr := p2.resultText()
	if strings.TrimSpace(out) != "bar" {
		t.Fatalf("env persist: stdout=%q stderr=%q", out, stderr)
	}
	if strings.Contains(out, doneMarkerPrefix) {
		t.Fatalf("marker leaked: %q", out)
	}

	p3, err := s.spawn("c3", "cd /tmp")
	if err != nil {
		t.Fatal(err)
	}
	waitPaneDone(t, p3)
	p4, err := s.spawn("c4", "pwd")
	if err != nil {
		t.Fatal(err)
	}
	waitPaneDone(t, p4)
	pwd, _ := p4.resultText()
	if !strings.Contains(strings.TrimSpace(pwd), "/tmp") {
		t.Fatalf("cwd persist: pwd=%q", pwd)
	}
	if p4.exitCode != 0 && p4.stillRunning() {
		t.Fatal("pwd still running")
	}
}
