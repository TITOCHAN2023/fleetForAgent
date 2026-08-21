package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestVTScreenCupHomedTwoLines(t *testing.T) {
	var replies bytes.Buffer
	sc := newVTScreen(livePtyCols, livePtyRows, &replies)
	sc.write([]byte("\x1b[H\x1b[2J\x1b[1;1Hline-one\x1b[2;1Hline-two"))
	text, _, _ := sc.grid()
	if strings.Contains(text, "\x1b") {
		t.Fatalf("read_screen must be the current frame, not CSI soup: %q", text)
	}
	lines := strings.Split(text, "\n")
	if len(lines) < 2 || lines[0] != "line-one" || lines[1] != "line-two" {
		t.Fatalf("grid=%q", text)
	}
}

func TestVTScreenAnswersDA(t *testing.T) {
	var replies bytes.Buffer
	sc := newVTScreen(livePtyCols, livePtyRows, &replies)
	sc.write([]byte("hello\x1b[c\x1b[0c"))
	got := replies.String()
	if strings.Count(got, daPrimary) < 2 {
		t.Fatalf("DA replies=%q", got)
	}
	text, _, _ := sc.grid()
	if strings.Contains(text, "\x1b") || strings.Contains(text, "[c") {
		t.Fatalf("DA query leaked into grid: %q", text)
	}
	if !strings.Contains(text, "hello") {
		t.Fatalf("grid lost hello: %q", text)
	}
}

func TestVTScreenAnswersCPR(t *testing.T) {
	var replies bytes.Buffer
	sc := newVTScreen(livePtyCols, livePtyRows, &replies)
	sc.write([]byte("\x1b[H\x1b[6n"))
	if !bytes.Contains(replies.Bytes(), []byte("\x1b[1;1R")) {
		t.Fatalf("CPR reply=%q", replies.Bytes())
	}
}

func TestVTScreenLeaveAltRestoresPrimary(t *testing.T) {
	var replies bytes.Buffer
	sc := newVTScreen(livePtyCols, livePtyRows, &replies)
	sc.write([]byte("shell-line\n"))
	sc.write([]byte("\x1b[?1049h\x1b[H\x1b[2JTUI-BOX"))
	text, _, _ := sc.grid()
	if !strings.Contains(text, "TUI-BOX") {
		t.Fatalf("expected alt-screen TUI, got %q", text)
	}
	sc.leaveAlt()
	text, _, _ = sc.grid()
	if strings.Contains(text, "TUI-BOX") {
		t.Fatalf("stale alt screen after leaveAlt: %q", text)
	}
	if !strings.Contains(text, "shell-line") {
		t.Fatalf("primary frame lost: %q", text)
	}
}

func TestVTScreenDASplitAcrossWrites(t *testing.T) {
	var replies bytes.Buffer
	sc := newVTScreen(livePtyCols, livePtyRows, &replies)
	sc.write([]byte("\x1b["))
	if replies.Len() != 0 {
		t.Fatalf("partial CSI must wait, got %q", replies.Bytes())
	}
	sc.write([]byte("c"))
	if !bytes.Contains(replies.Bytes(), []byte(daPrimary)) {
		t.Fatalf("split DA not answered: %q", replies.Bytes())
	}
}
