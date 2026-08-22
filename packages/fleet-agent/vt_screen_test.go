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
	if !sc.answered() {
		t.Fatal("DA must mark answeredQuery")
	}
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
	if !sc.answered() {
		t.Fatal("CPR must mark answeredQuery")
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

func TestVTScreenResetClearsPrimaryTUI(t *testing.T) {
	var replies bytes.Buffer
	sc := newVTScreen(livePtyCols, livePtyRows, &replies)
	sc.write([]byte("\x1b[H\x1b[2J====CODEX====\n| box |\n============\n"))
	text, _, _ := sc.grid()
	if !strings.Contains(text, "CODEX") {
		t.Fatalf("expected primary TUI, got %q", text)
	}
	sc.resetPrimary()
	text, _, _ = sc.grid()
	if strings.Contains(text, "CODEX") || strings.Contains(text, "box") {
		t.Fatalf("reset left chrome: %q", text)
	}
	sc.replay([]byte("/Users/bytedance\n"))
	text, _, _ = sc.grid()
	if strings.TrimSpace(text) != "/Users/bytedance" {
		t.Fatalf("replay paint=%q", text)
	}
}

func TestVTScreenReplayCupAfterReset(t *testing.T) {
	var replies bytes.Buffer
	sc := newVTScreen(livePtyCols, livePtyRows, &replies)
	sc.write([]byte("leftover\n"))
	sc.resetPrimary()
	sc.replay([]byte("\x1b[H\x1b[2J\x1b[1;1Hline-one\x1b[2;1Hline-two"))
	text, _, _ := sc.grid()
	if strings.Contains(text, "\x1b") || strings.Contains(text, "leftover") {
		t.Fatalf("replay grid=%q", text)
	}
	lines := strings.Split(text, "\n")
	if len(lines) < 2 || lines[0] != "line-one" || lines[1] != "line-two" {
		t.Fatalf("CUP replay want line-one/line-two, got %q", text)
	}
}

func TestVTScreenNoReplayAfterAlt(t *testing.T) {
	var replies bytes.Buffer
	sc := newVTScreen(livePtyCols, livePtyRows, &replies)
	sc.write([]byte("\x1b[?1049h\x1b[H\x1b[2JTUI-BOX\x1b[?1049l"))
	if !sc.altUsed() {
		t.Fatal("smcup must set usedAlt even when rmcup follows in the same write")
	}
	sc.resetPrimary()
	text, _, _ := sc.grid()
	if strings.Contains(text, "TUI-BOX") {
		t.Fatalf("alt reset without replay must be empty, got %q", text)
	}
	if sc.altUsed() {
		t.Fatal("resetPrimary must clear usedAlt")
	}
	if sc.answered() {
		t.Fatal("resetPrimary must clear answeredQuery")
	}
}

func TestVTScreenReplayDoesNotAnswerDA(t *testing.T) {
	var replies bytes.Buffer
	sc := newVTScreen(livePtyCols, livePtyRows, &replies)
	sc.resetPrimary()
	before := replies.Len()
	sc.replay([]byte("\x1b[cplain\n"))
	if replies.Len() != before {
		t.Fatalf("replay must not write DA to the PTY master: %q", replies.Bytes())
	}
	text, _, _ := sc.grid()
	if !strings.Contains(text, "plain") {
		t.Fatalf("replay lost plain text: %q", text)
	}
}

func TestVTScreenGridStripsPromptMarker(t *testing.T) {
	var replies bytes.Buffer
	sc := newVTScreen(livePtyCols, livePtyRows, &replies)
	sc.write([]byte("pwd-line\n" + promptPrefix + "0\n"))
	text, _, _ := sc.grid()
	if strings.Contains(text, promptPrefix) {
		t.Fatalf("read_screen leaked completion marker: %q", text)
	}
	if !strings.Contains(text, "pwd-line") {
		t.Fatalf("grid lost output: %q", text)
	}
}

func TestVTScreenConcurrentResetWriteGrid(t *testing.T) {
	var replies bytes.Buffer
	sc := newVTScreen(livePtyCols, livePtyRows, &replies)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 80; i++ {
			sc.write([]byte("hello\n"))
			_, _, _ = sc.grid()
			_ = sc.altUsed()
			_ = sc.answered()
		}
	}()
	for i := 0; i < 80; i++ {
		sc.resetPrimary()
		sc.replay([]byte("pwd\n"))
		_, _, _ = sc.grid()
		sc.leaveAlt()
	}
	<-done
	text, _, _ := sc.grid()
	if strings.Contains(text, "\x00") {
		t.Fatalf("torn grid: %q", text)
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
