package main

import (
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

func testPane() *pane {
	return &pane{
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
	out, err := p.resultText()
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
	out, err := p.resultText()
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
	out, err := p.resultText()
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
	out, _ := p.resultText()
	if !utf8.ValidString(out) {
		t.Fatalf("result stdout is not valid UTF-8")
	}
}
