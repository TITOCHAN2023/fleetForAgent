package pane

import (
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

func testPane() *Pane {
	return &Pane{
		lines:  []string{""},
		stdout: newStreamBuf(),
		stderr: newStreamBuf(),
	}
}

func TestResultKeepsHeadAndTail(t *testing.T) {
	p := testPane()
	for i := 1; i <= 8000; i++ {
		p.append("stdout", fmt.Sprintf("n=%d\n", i))
	}
	out, err := p.ResultText()
	if err != "" {
		t.Fatalf("stderr=%q", err)
	}
	if !strings.Contains(out, "n=1") {
		t.Fatalf("missing beginning: %q", out[:min(80, len(out))])
	}
	if !strings.Contains(out, "n=8000") {
		t.Fatalf("missing end")
	}
	if !strings.Contains(out, "omitted") {
		t.Fatalf("expected head-and-tail omission, got %d bytes", len(out))
	}
	if strings.Contains(out, "n=4000") {
		t.Fatalf("middle of a long command should be omitted")
	}
	text, _, _, _ := p.snapshot()
	screen := strings.Split(text, "\n")
	if len(screen) > screenLines {
		t.Fatalf("screen snapshot %d lines, want <= %d", len(screen), screenLines)
	}
	if !strings.Contains(text, "n=8000") {
		t.Fatalf("screen should still show the tail")
	}
	if strings.Contains(text, "n=1") {
		t.Fatalf("screen snapshot must stay last %d lines", screenLines)
	}
}

func TestStdoutStderrSplit(t *testing.T) {
	p := testPane()
	p.append("stdout", "out-line\n")
	p.append("stderr", "err-line\n")
	out, err := p.ResultText()
	if !strings.Contains(out, "out-line") {
		t.Fatalf("stdout=%q", out)
	}
	if strings.Contains(out, "err-line") {
		t.Fatalf("stderr leaked into stdout: %q", out)
	}
	if !strings.Contains(err, "err-line") {
		t.Fatalf("stderr=%q", err)
	}
	if strings.Contains(err, "out-line") {
		t.Fatalf("stdout leaked into stderr: %q", err)
	}
}

func TestShortCommandHasNoOmission(t *testing.T) {
	p := testPane()
	p.append("stdout", "hello\nworld\n")
	out, err := p.ResultText()
	if err != "" {
		t.Fatalf("stderr=%q", err)
	}
	if strings.Contains(out, "omitted") {
		t.Fatalf("short output should not omit: %q", out)
	}
	if out != "hello\nworld" {
		t.Fatalf("stdout=%q", out)
	}
}

func TestResultIsValidUTF8(t *testing.T) {
	p := testPane()
	p.append("stdout", "ok \xff more\n")
	out, _ := p.ResultText()
	if !utf8.ValidString(out) {
		t.Fatalf("result stdout is not valid UTF-8")
	}
}

func TestGetForIsolatesFingerprints(t *testing.T) {
	s := NewSupervisor()
	a := &Pane{id: "pane-a", corr: "ca", fingerprint: "fp-a", running: true}
	b := &Pane{id: "pane-b", corr: "cb", fingerprint: "fp-b", running: true}
	s.panes["pane-a"] = a
	s.panes["ca"] = a
	s.panes["pane-b"] = b
	s.panes["cb"] = b
	s.order = []string{"pane-a", "pane-b"}

	if got := s.GetFor("fp-a", ""); got != a {
		t.Fatalf("empty id for fp-a got %#v", got)
	}
	if got := s.GetFor("fp-b", ""); got != b {
		t.Fatalf("empty id for fp-b got %#v", got)
	}
	if got := s.GetFor("fp-a", "cb"); got != nil {
		t.Fatal("fp-a must not see fp-b's ticket")
	}
	if got := s.GetFor("fp-b", "ca"); got != nil {
		t.Fatal("fp-b must not see fp-a's ticket")
	}
	if got := s.GetFor("fp-a", "ca"); got != a {
		t.Fatalf("own ticket should resolve, got %#v", got)
	}
	if got := s.get(""); got != b {
		t.Fatalf("anonymous get() stays last pane for old clients, got %#v", got)
	}
}
