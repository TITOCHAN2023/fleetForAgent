package main

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func waitPaneDone(t *testing.T, p *pane) {
	t.Helper()
	deadline := time.Now().Add(25 * time.Second)
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

func TestPickShellIgnoresInheritedSHELL(t *testing.T) {
	t.Setenv("SHELL", "/bin/false")
	t.Setenv("FLEET_SHELL", "")
	got := pickShell()
	if got == "/bin/false" {
		t.Fatal("inherited SHELL must not win")
	}
	override := "/bin/bash"
	if !fileExists(override) {
		override = "/bin/sh"
	}
	t.Setenv("FLEET_SHELL", override)
	if pickShell() != override {
		t.Fatalf("FLEET_SHELL should win, got %q", pickShell())
	}
}

func TestLiveShellStartsInHomeAndExpandsAlias(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("live shell is POSIX-only")
	}
	home := userHome()
	if home == "" {
		t.Skip("no home")
	}
	s := newSupervisor()
	t.Cleanup(func() {
		s.mu.Lock()
		if s.live != nil {
			s.live.kill()
		}
		s.mu.Unlock()
	})

	p1, err := s.spawn("h1", "pwd")
	if err != nil {
		t.Fatal(err)
	}
	waitPaneDone(t, p1)
	pwd, _ := p1.resultText()
	got, err := filepath.EvalSymlinks(strings.TrimSpace(pwd))
	if err != nil {
		got = strings.TrimSpace(pwd)
	}
	want, err := filepath.EvalSymlinks(home)
	if err != nil {
		want = home
	}
	if got != want && !strings.HasPrefix(got, want) && filepath.Clean(got) != filepath.Clean(want) {
		t.Fatalf("first pwd=%q want home %q (raw %q)", got, want, pwd)
	}

	p2, err := s.spawn("a1", "alias ll='ls -ld'")
	if err != nil {
		t.Fatal(err)
	}
	waitPaneDone(t, p2)
	p3, err := s.spawn("a2", "type ll")
	if err != nil {
		t.Fatal(err)
	}
	waitPaneDone(t, p3)
	typed, stderr := p3.resultText()
	if !strings.Contains(typed, "ll") || !(strings.Contains(typed, "alias") || strings.Contains(typed, "ls -ld")) {
		t.Fatalf("type ll should find alias, stdout=%q stderr=%q", typed, stderr)
	}

	p4, err := s.spawn("e1", "cd /tmp")
	if err != nil {
		t.Fatal(err)
	}
	waitPaneDone(t, p4)
	p5, err := s.spawn("e2", "exit")
	if err != nil {
		t.Fatal(err)
	}
	waitPaneDone(t, p5)
	p6, err := s.spawn("e3", "pwd")
	if err != nil {
		t.Fatal(err)
	}
	waitPaneDone(t, p6)
	pwd2, _ := p6.resultText()
	got2, err := filepath.EvalSymlinks(strings.TrimSpace(pwd2))
	if err != nil {
		got2 = strings.TrimSpace(pwd2)
	}
	if got2 != want && !strings.HasPrefix(got2, want) && filepath.Clean(got2) != filepath.Clean(want) {
		t.Fatalf("after exit pwd=%q want home %q (raw %q)", got2, want, pwd2)
	}
}
