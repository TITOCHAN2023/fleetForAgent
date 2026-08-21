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

func waitPaneTypable(t *testing.T, p *pane) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		p.mu.Lock()
		w := p.stdin
		running := p.running
		p.mu.Unlock()
		if running && w != nil {
			time.Sleep(150 * time.Millisecond)
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("pane %s never became typable", p.corr)
}

func assertNoCompletion(t *testing.T, out, stderr string) {
	t.Helper()
	for _, s := range []string{out, stderr} {
		if strings.Contains(s, promptPrefix) || strings.Contains(s, doneMarkerPrefix) {
			t.Fatalf("completion text leaked: stdout=%q stderr=%q", out, stderr)
		}
	}
}

func TestParsePrompt(t *testing.T) {
	out, rest, code, ok := parsePrompt("hello\n" + promptPrefix + "0\nmore\n")
	if !ok {
		t.Fatal("expected prompt")
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
	_, _, _, ok = parsePrompt("hello " + promptPrefix + "1")
	if ok {
		t.Fatal("incomplete (no newline) must not parse")
	}
	out, _, code, ok = parsePrompt("oops\n" + promptPrefix + "7\n")
	if !ok || code != 7 || out != "oops\n" {
		t.Fatalf("exit 7: ok=%v code=%d out=%q", ok, code, out)
	}
	echoed := "PS1='" + promptPrefix + "$?'\n" + promptPrefix + "0\n"
	out, rest, code, ok = parsePrompt(echoed)
	if !ok || code != 0 {
		t.Fatalf("PS1 assignment must be skipped: ok=%v code=%d out=%q", ok, code, out)
	}
	if strings.Contains(out, promptPrefix+"0") {
		t.Fatalf("prompt leaked into output: %q", out)
	}
	out, _, code, ok = parsePrompt("bar" + promptPrefix + "0\n")
	if !ok || code != 0 || out != "bar" {
		t.Fatalf("no-newline output: ok=%v code=%d out=%q", ok, code, out)
	}
}

func TestExitCommandCode(t *testing.T) {
	if _, ok := exitCommandCode("echo hi"); ok {
		t.Fatal("echo is not exit")
	}
	code, ok := exitCommandCode("exit")
	if !ok || code != 0 {
		t.Fatalf("exit: ok=%v code=%d", ok, code)
	}
	code, ok = exitCommandCode("exit 3")
	if !ok || code != 3 {
		t.Fatalf("exit 3: ok=%v code=%d", ok, code)
	}
	if _, ok := exitCommandCode("exit; echo hi"); ok {
		t.Fatal("compound exit must not short-circuit")
	}
}

func TestHasReadyLine(t *testing.T) {
	if hasReadyLine("PS1='" + promptPrefix + "$?'\n") {
		t.Fatal("PS1 assignment must not count as ready")
	}
	if !hasReadyLine("noise\n" + promptPrefix + "0\n") {
		t.Fatal("expected prompt ready line")
	}
}

func TestStripCompletionText(t *testing.T) {
	in := "keep\n" + promptPrefix + "0\nkeep2\n"
	got := stripCompletionText(in)
	if strings.Contains(got, promptPrefix) {
		t.Fatalf("prompt leaked: %q", got)
	}
	if !strings.Contains(got, "keep") || !strings.Contains(got, "keep2") {
		t.Fatalf("stripped too much: %q", got)
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
	assertNoCompletion(t, out, stderr)

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
	assertNoCompletion(t, typed, stderr)

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
	if p5.exitCode != 0 {
		t.Fatalf("exit command exit_code=%d want 0", p5.exitCode)
	}
}

func TestLiveShellEchoHiHasCleanStreams(t *testing.T) {
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

	p, err := s.spawn("hi1", "echo hi")
	if err != nil {
		t.Fatal(err)
	}
	waitPaneDone(t, p)
	out, stderr := p.resultText()
	if strings.TrimSpace(out) != "hi" {
		t.Fatalf("stdout=%q want hi", out)
	}
	if strings.TrimSpace(stderr) != "" {
		t.Fatalf("stderr should be empty, got %q", stderr)
	}
	assertNoCompletion(t, out, stderr)
	if strings.Contains(out, "echo hi") || strings.Contains(stderr, "echo hi") {
		t.Fatalf("typed command echoed: stdout=%q stderr=%q", out, stderr)
	}

	p2, err := s.spawn("hi2", "echo err >&2")
	if err != nil {
		t.Fatal(err)
	}
	waitPaneDone(t, p2)
	out2, err2 := p2.resultText()
	if strings.TrimSpace(out2) != "" {
		t.Fatalf("stdout should be empty for >&2, got %q", out2)
	}
	if !strings.Contains(err2, "err") {
		t.Fatalf("stderr=%q want err", err2)
	}
	assertNoCompletion(t, out2, err2)
}

func TestLiveShellReadThenType(t *testing.T) {
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

	p, err := s.spawn("rd1", `read -r x; printf 'got=%s\n' "$x"`)
	if err != nil {
		t.Fatal(err)
	}
	waitPaneTypable(t, p)
	if !p.stillRunning() {
		out, stderr := p.resultText()
		t.Fatalf("read finished before type: stdout=%q stderr=%q", out, stderr)
	}
	if err := p.typeKeys("typed_ok\n"); err != nil {
		t.Fatal(err)
	}
	waitPaneDone(t, p)
	out, stderr := p.resultText()
	if strings.TrimSpace(out) != "got=typed_ok" {
		t.Fatalf("stdout=%q want got=typed_ok (stderr=%q)", out, stderr)
	}
	if strings.Contains(out, "got=printf") || strings.Contains(out, doneMarkerPrefix) {
		t.Fatalf("read consumed a completion printf: %q", out)
	}
	assertNoCompletion(t, out, stderr)
}

func TestLiveShellTTYAndTerm(t *testing.T) {
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

	p, err := s.spawn("tty1", `tty; printf 'TERM=%s\n' "$TERM"`)
	if err != nil {
		t.Fatal(err)
	}
	waitPaneDone(t, p)
	out, stderr := p.resultText()
	if strings.Contains(out, "not a tty") {
		t.Fatalf("tty should be a real PTY, got %q (stderr=%q)", out, stderr)
	}
	if !strings.Contains(out, "/dev/") {
		t.Fatalf("tty path missing: %q", out)
	}
	if !strings.Contains(out, "TERM=xterm-256color") {
		t.Fatalf("TERM=%q want xterm-256color", out)
	}
	assertNoCompletion(t, out, stderr)
}
