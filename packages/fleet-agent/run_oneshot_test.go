//go:build !windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func newRunSupervisor(t *testing.T) *supervisor {
	t.Helper()
	s := newSupervisor()
	t.Cleanup(s.killAllLive)
	return s
}

func TestRunMultilinePythonCFinishes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX oneshot")
	}
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("no python3")
	}
	s := newRunSupervisor(t)
	cmd := "python3 -c 'print(\"line-a\")\nprint(\"line-b\")'"
	p, err := s.spawn("ml1", cmd)
	if err != nil {
		t.Fatal(err)
	}
	waitPaneDone(t, p)
	if p.stillRunning() {
		t.Fatal("multiline python -c hung (PS2 would never finish)")
	}
	out, stderr := p.resultText()
	if p.exitCode != 0 {
		t.Fatalf("exit=%d stdout=%q stderr=%q", p.exitCode, out, stderr)
	}
	if !strings.Contains(out, "line-a") || !strings.Contains(out, "line-b") {
		t.Fatalf("stdout=%q", out)
	}
	assertNoCompletion(t, out, stderr)
}

func TestRunQuotedJSONArgvFinishes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX oneshot")
	}
	s := newRunSupervisor(t)
	cmd := `printf '%s\n' '{"items":[1,2,3],"q":"yes?"}'`
	p, err := s.spawn("json1", cmd)
	if err != nil {
		t.Fatal(err)
	}
	waitPaneDone(t, p)
	if p.stillRunning() {
		t.Fatal("quoted JSON hung (completion/PS2)")
	}
	out, stderr := p.resultText()
	if p.exitCode != 0 {
		t.Fatalf("exit=%d stdout=%q stderr=%q", p.exitCode, out, stderr)
	}
	if !strings.Contains(out, `"items"`) || !strings.Contains(out, "yes?") {
		t.Fatalf("stdout=%q", out)
	}
	if strings.Contains(out, "Display all") || strings.Contains(stderr, "Display all") {
		t.Fatalf("shell completion leaked: stdout=%q stderr=%q", out, stderr)
	}
	assertNoCompletion(t, out, stderr)
}

func TestRunGitLogWithoutPagerFinishes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX oneshot")
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	dir := t.TempDir()
	runGit := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=fleet", "GIT_AUTHOR_EMAIL=fleet@example.com",
			"GIT_COMMITTER_NAME=fleet", "GIT_COMMITTER_EMAIL=fleet@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	runGit("init")
	runGit("config", "user.email", "fleet@example.com")
	runGit("config", "user.name", "fleet")
	if err := os.WriteFile(filepath.Join(dir, "README"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit("add", "README")
	runGit("commit", "-m", "init")

	s := newRunSupervisor(t)
	p, err := s.spawn("git1", "git -C "+strconv.Quote(dir)+" log")
	if err != nil {
		t.Fatal(err)
	}
	waitPaneDone(t, p)
	if p.stillRunning() {
		t.Fatal("git log hung in less")
	}
	out, stderr := p.resultText()
	if p.exitCode != 0 {
		t.Fatalf("exit=%d stdout=%q stderr=%q", p.exitCode, out, stderr)
	}
	if !strings.Contains(out, "init") {
		t.Fatalf("git log stdout=%q", out)
	}
	if strings.Contains(out, "\x1b[?1049") || strings.TrimSpace(out) == ":" {
		t.Fatalf("pager chrome in output: %q", out)
	}
}

func TestRunStripsOSCPrefixFromStdout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX oneshot")
	}
	s := newRunSupervisor(t)
	p, err := s.spawn("osc1", `printf '\033]11;?\007\033[6nhello-osc\n'`)
	if err != nil {
		t.Fatal(err)
	}
	waitPaneDone(t, p)
	out, stderr := p.resultText()
	if p.exitCode != 0 {
		t.Fatalf("exit=%d stdout=%q stderr=%q", p.exitCode, out, stderr)
	}
	if strings.Contains(out, "]11;?") || strings.Contains(out, "[6n") || strings.Contains(out, "\x1b]11") {
		t.Fatalf("probe sequences leaked: %q", out)
	}
	if !strings.Contains(out, "hello-osc") {
		t.Fatalf("stdout=%q", out)
	}
}

func TestRunCJKArgvSurvives(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX oneshot")
	}
	s := newRunSupervisor(t)
	p, err := s.spawn("cjk1", `printf '%s\n' '杨杰'`)
	if err != nil {
		t.Fatal(err)
	}
	waitPaneDone(t, p)
	out, stderr := p.resultText()
	if p.exitCode != 0 {
		t.Fatalf("exit=%d stdout=%q stderr=%q", p.exitCode, out, stderr)
	}
	if !strings.Contains(out, "杨杰") {
		t.Fatalf("CJK vanished: stdout=%q stderr=%q", out, stderr)
	}

	if _, err := exec.LookPath("python3"); err == nil {
		p2, err := s.spawn("cjk2", `python3 -c 'import sys; print(sys.argv[1])' 杨杰`)
		if err != nil {
			t.Fatal(err)
		}
		waitPaneDone(t, p2)
		out2, err2 := p2.resultText()
		if p2.exitCode != 0 || !strings.Contains(out2, "杨杰") {
			t.Fatalf("python argv CJK: exit=%d stdout=%q stderr=%q", p2.exitCode, out2, err2)
		}
	}
}

func TestRunDoesNotQueueOnSharedPTY(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX oneshot")
	}
	s := newRunSupervisor(t)
	stuck, err := s.spawn("q1", "sleep 30")
	if err != nil {
		t.Fatal(err)
	}
	waitPaneTypable(t, stuck)
	if !stuck.stillRunning() {
		t.Fatal("sleep should still be running")
	}

	second, err := s.spawn("q2", "printf 'second-ok\\n'")
	if err != nil {
		t.Fatal(err)
	}
	waitPaneDone(t, second)
	if second.stillRunning() {
		t.Fatal("second run queued behind the first")
	}
	out, _ := second.resultText()
	if !strings.Contains(out, "second-ok") {
		t.Fatalf("second stdout=%q", out)
	}
	if second.stdin == stuck.stdin {
		t.Fatal("later run reused the first PTY")
	}
	if !stuck.stillRunning() {
		t.Fatal("first sleep should keep running on its own process")
	}
}

func TestRunCommandEnvDefaults(t *testing.T) {
	t.Setenv("TERM", "dumb")
	t.Setenv("NO_COLOR", "1")
	t.Setenv("PAGER", "less")
	t.Setenv("LANG", "C")
	env := runCommandEnv()
	got := map[string]string{}
	for _, e := range env {
		k, v, _ := strings.Cut(e, "=")
		got[k] = v
	}
	if got["TERM"] != "xterm-256color" {
		t.Fatalf("TERM=%q", got["TERM"])
	}
	if got["PAGER"] != "cat" || got["GIT_PAGER"] != "cat" {
		t.Fatalf("pagers=%q %q", got["PAGER"], got["GIT_PAGER"])
	}
	if got["LANG"] != "C.UTF-8" || got["LC_ALL"] != "C.UTF-8" {
		t.Fatalf("locale LANG=%q LC_ALL=%q", got["LANG"], got["LC_ALL"])
	}
	if _, ok := got["NO_COLOR"]; ok {
		t.Fatal("NO_COLOR leaked")
	}
}

func TestLiveSetupDisablesCompletion(t *testing.T) {
	setup := liveSetupCommand()
	if !strings.Contains(setup, "disable-completion") {
		t.Fatal("setup must disable bash completion, not only bracketed paste")
	}
	if !strings.Contains(setup, "PAGER=cat") || !strings.Contains(setup, "LANG=C.UTF-8") {
		t.Fatal("setup must export PAGER and UTF-8 locale")
	}
}

func TestRunUsesOneshotNotLiveQueue(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX oneshot")
	}
	s := newRunSupervisor(t)
	p, err := s.spawn("os1", "true")
	if err != nil {
		t.Fatal(err)
	}
	waitPaneDone(t, p)
	if p.cmd == nil {
		t.Fatal("run must be a child process, not text typed into a live login shell")
	}
	if s.liveFor("") != nil {
		t.Fatal("run must not start the shared interactive login PTY")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		pending := s.slotLocked("").pending
		s.mu.Unlock()
		if pending == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("oneshot run left a live-shell pending job")
}
