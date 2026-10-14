package pane

import (
	"encoding/base64"
	"fmt"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"
)

func TestExistingSingleLineWindowPreservesStructuredOutput(t *testing.T) {
	for _, size := range []int{10 * 1024, 60 * 1024, rawOutMaxBytes} {
		json := `{"data":"` + strings.Repeat("a", size-len(`{"data":""}`)) + `"}`
		encoded := base64.StdEncoding.EncodeToString(make([]byte, size*3/4))
		for name, input := range map[string]string{"json": json, "base64": encoded} {
			for _, mode := range []string{"single", "chunks", "finish"} {
				t.Run(fmt.Sprintf("%s/%d/%s", name, size, mode), func(t *testing.T) {
					p := testPane()
					switch mode {
					case "single":
						p.append("stdout", input)
					case "chunks":
						for pos := 0; pos < len(input); pos += 4096 {
							p.append("stdout", input[pos:min(pos+4096, len(input))])
						}
					case "finish":
						p.finishCommand(input, 0)
					}
					out, _ := p.ResultText()
					screen, _, _, _ := p.snapshot()
					if out != input || screen != input {
						t.Fatalf("existing %d-byte output changed: result=%d screen=%d", len(input), len(out), len(screen))
					}
				})
			}
		}
	}
}

func TestSingleLineOverExistingWindowIsExplicitlyTruncated(t *testing.T) {
	p := testPane()
	p.append("stdout", "begin:"+strings.Repeat("x", rawOutMaxBytes)+":end")
	out, _ := p.ResultText()
	if len(out) > rawOutMaxBytes || !strings.HasPrefix(out, "begin:") || !strings.HasSuffix(out, ":end") || strings.Count(out, byteOmission) != 1 {
		t.Fatalf("invalid truncation: %d bytes", len(out))
	}
}

func TestLongLineHasByteBoundAndKeepsEnds(t *testing.T) {
	p := testPane()
	p.running = true
	p.append("stdout", "begin:")
	for i := 0; i < 512; i++ {
		p.append("stdout", strings.Repeat("界", 1024))
	}
	p.append("stdout", ":end")
	out, _ := p.ResultText()
	screen, running, _, _ := p.snapshot()
	for name, text := range map[string]string{"stdout": out, "screen": screen} {
		if len(text) > lineMaxBytes || !utf8.ValidString(text) || !strings.HasPrefix(text, "begin:") || !strings.HasSuffix(text, ":end") || !strings.Contains(text, "bytes omitted") {
			t.Errorf("%s: bytes=%d valid=%v missing bounds/ends/marker", name, len(text), utf8.ValidString(text))
		}
	}
	if !running {
		t.Fatal("truncation stopped a running task")
	}
}

func TestOutputBudgetsBoundManyLargeLines(t *testing.T) {
	p := testPane()
	for i := 0; i < 500; i++ {
		p.append("stdout", fmt.Sprintf("row=%03d %s\n", i, strings.Repeat("x", lineMaxBytes)))
	}
	out, _ := p.ResultText()
	if len(out) > 2*streamPartMaxBytes+lineMaxBytes+headLines+ringLines+128 || !strings.Contains(out, "row=000") || !strings.Contains(out, "row=499") || !strings.Contains(out, "lines omitted") {
		t.Fatalf("bad byte budget or head/tail: %d bytes", len(out))
	}
	if size := len(strings.Join(p.lines, "\n")); size > displayMaxBytes+ringLines {
		t.Fatalf("display retained %d bytes", size)
	}
}

func TestTakeDirtyRotatesDespiteContinuousNewestOutput(t *testing.T) {
	s := NewSupervisor()
	panes := []*Pane{registeredPane(s, "one", "a"), registeredPane(s, "two", "b"), registeredPane(s, "three", "c")}
	seen := map[*Pane]bool{}
	for _, p := range panes {
		p.append("stdout", "start")
	}
	for range panes {
		panes[2].append("stdout", "busy")
		p := s.TakeDirty()
		if p == nil {
			t.Fatal("missing dirty pane")
		}
		seen[p] = true
		p.SnapshotFrame()
	}
	if len(seen) != len(panes) {
		t.Fatalf("only %d of %d panes serviced", len(seen), len(panes))
	}
}

func TestConcurrentOutputAndDirtySnapshots(t *testing.T) {
	s := NewSupervisor()
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		p := registeredPane(s, fmt.Sprint(i), fmt.Sprint(i))
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				p.append("stdout", strings.Repeat("界", 1024))
				p.ResultText()
			}
		}()
	}
	for i := 0; i < 800; i++ {
		if p := s.TakeDirty(); p != nil {
			p.SnapshotFrame()
		}
	}
	wg.Wait()
}

func TestByteBoundsForSingleChunkAndFinishRewrite(t *testing.T) {
	for _, finish := range []bool{false, true} {
		p := testPane()
		p.running = true
		chunk := "begin:" + strings.Repeat("🦀界", 200000) + ":end"
		if finish {
			p.finishCommand(chunk, 17)
		} else {
			p.append("stderr", chunk)
		}
		out, errout := p.ResultText()
		if !finish {
			out = errout
		}
		text, running, code, _ := p.snapshot()
		for _, result := range []string{out, text} {
			if len(result) > lineMaxBytes || !utf8.ValidString(result) || !strings.HasPrefix(result, "begin:") || !strings.HasSuffix(result, ":end") || strings.Count(result, byteOmission) != 1 {
				t.Fatalf("finish=%v: bad bounded UTF-8 output (%d bytes)", finish, len(result))
			}
		}
		if finish && (running || code != 17) {
			t.Fatal("completion state changed")
		}
		if !finish && !running {
			t.Fatal("append stopped process")
		}
	}
}

func TestManyLinesInSingleChunkKeepBoundedStorage(t *testing.T) {
	p := testPane()
	p.append("stdout", strings.Repeat("first\n", 100000)+"last")
	out, _ := p.ResultText()
	if !strings.HasPrefix(out, "first") || !strings.HasSuffix(out, "last") || !strings.Contains(out, "lines omitted") {
		t.Fatal("head/tail changed")
	}
	if len(p.lines) > ringLines || cap(p.lines) > 2*ringLines {
		t.Fatalf("retained display slice capacity len=%d cap=%d", len(p.lines), cap(p.lines))
	}
}

func TestDirtyCursorSurvivesRetirementAndSnapshotClearsDirty(t *testing.T) {
	s := NewSupervisor()
	first := registeredPane(s, "old", "a")
	first.finishCommand("old", 0)
	active := registeredPane(s, "active", "b")
	active.append("stdout", "running")
	if s.TakeDirty() != first {
		t.Fatal("expected first pane")
	}
	s.PaneSnapshot(first)
	if first.dirty {
		t.Fatal("snapshot did not clear dirty")
	}
	for i := 0; i < completedPaneLimit; i++ {
		p := registeredPane(s, fmt.Sprintf("done-%d", i), "c")
		p.finishCommand("done", 0)
		s.PaneSnapshot(p)
	}
	if s.GetFor("a", "old") != nil {
		t.Fatal("old pane was not retired")
	}
	if s.TakeDirty() != active {
		t.Fatal("retirement skipped active pane")
	}
	s.PaneSnapshot(active)
	if s.TakeDirty() != nil {
		t.Fatal("clean panes returned as dirty")
	}
	p := registeredPane(s, "new", "d")
	p.append("stdout", "new")
	if s.TakeDirty() != p {
		t.Fatal("new registration not served")
	}
	if NewSupervisor().TakeDirty() != nil {
		t.Fatal("empty supervisor has dirty pane")
	}
}
