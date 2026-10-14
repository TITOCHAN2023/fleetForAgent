package pane

import (
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"
)

// Keep read boundaries deterministic without starting a process or using a PTY.
type chunkReader struct {
	chunks []string
	final  error
}

func (r *chunkReader) Read(buf []byte) (int, error) {
	for len(r.chunks) > 0 && r.chunks[0] == "" {
		r.chunks = r.chunks[1:]
	}
	if len(r.chunks) == 0 {
		return 0, io.EOF
	}
	n := copy(buf, r.chunks[0])
	r.chunks[0] = r.chunks[0][n:]
	if len(r.chunks) == 1 && r.chunks[0] == "" {
		return n, r.final
	}
	return n, nil
}

func TestDrainUTF8EveryByteSplit(t *testing.T) {
	for _, input := range []string{"中", "🦀", "before:中文🦀🙂:after"} {
		for split := 0; split <= len(input); split++ {
			for _, final := range []error{nil, io.EOF, io.ErrUnexpectedEOF} {
				t.Run(fmt.Sprintf("%s/%d/%v", input, split, final), func(t *testing.T) {
					p := testPane()
					drain(p, &chunkReader{chunks: []string{input[:split], input[split:]}, final: final}, "stdout")
					out, errout := p.ResultText()
					screen, _, _, _ := p.snapshot()
					if out != input || screen != input || errout != "" {
						t.Fatalf("split=%d: stdout=%q screen=%q stderr=%q", split, out, screen, errout)
					}
				})
			}
		}
	}
}

func TestDrainUTF8InvalidAndIncompleteEOF(t *testing.T) {
	for _, tc := range []struct {
		chunks []string
		want   string
	}{
		{[]string{"ok", "\xff", ":end"}, "ok�:end"},
		{[]string{"ok", "\xe4", "\xb8"}, "ok�"},
		{[]string{"ok", "\xf0\x9f", "\xa6"}, "ok�"},
		{[]string{"\xe4", "X", "\x80"}, "�X�"},
		{[]string{"\xff", "\xe4", "\xb8\xad"}, "�中"},
		{[]string{"\xf0\x9f\xa6", "\x80", "\xe4"}, "🦀�"},
	} {
		for _, final := range []error{nil, io.EOF, io.ErrUnexpectedEOF} {
			p := testPane()
			drain(p, &chunkReader{chunks: append([]string(nil), tc.chunks...), final: final}, "stderr")
			out, errout := p.ResultText()
			screen, _, _, _ := p.snapshot()
			if out != "" || errout != tc.want || screen != tc.want {
				t.Fatalf("chunks=%q final=%v: stdout=%q stderr=%q screen=%q want=%q", tc.chunks, final, out, errout, screen, tc.want)
			}
		}
	}
}

func TestDrainUTF8ConcurrentStreamsStayIndependent(t *testing.T) {
	p := testPane()
	var wg sync.WaitGroup
	for which, input := range map[string]string{"stdout": strings.Repeat("中", 200), "stderr": strings.Repeat("🦀", 200)} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			chunks := make([]string, len(input))
			for i := 0; i < len(input); i++ {
				chunks[i] = input[i : i+1]
			}
			drain(p, &chunkReader{chunks: chunks}, which)
		}()
	}
	wg.Wait()
	out, errout := p.ResultText()
	screen, _, _, _ := p.snapshot()
	if out != strings.Repeat("中", 200) || errout != strings.Repeat("🦀", 200) || strings.Count(screen, "中") != 200 || strings.Count(screen, "🦀") != 200 || !utf8.ValidString(screen) {
		t.Fatalf("streams mixed or damaged: stdout=%q stderr=%q screen=%q", out, errout, screen)
	}
}

type pausedUTF8Reader struct {
	waiting chan struct{}
	resume  chan struct{}
	started bool
}

func (r *pausedUTF8Reader) Read(buf []byte) (int, error) {
	if !r.started {
		r.started = true
		return copy(buf, "\xe4"), nil
	}
	close(r.waiting)
	<-r.resume
	return copy(buf, "\xb8\xad"), io.EOF
}

func TestDrainUTF8InterleavedStreamsDoNotCombinePartialRunes(t *testing.T) {
	p := testPane()
	r := &pausedUTF8Reader{waiting: make(chan struct{}), resume: make(chan struct{})}
	done := make(chan struct{})
	go func() {
		defer close(done)
		drain(p, r, "stdout")
	}()
	<-r.waiting // stdout's leading byte has been processed but is incomplete.
	drain(p, strings.NewReader("\x80"), "stderr")
	close(r.resume)
	<-done
	out, errout := p.ResultText()
	screen, _, _, _ := p.snapshot()
	if out != "中" || errout != "�" || screen != "�中" {
		t.Fatalf("partial bytes crossed streams: stdout=%q stderr=%q screen=%q", out, errout, screen)
	}
}

func TestDrainUTF8ReadBoundaryAndByteBudget(t *testing.T) {
	for _, size := range []int{4094, 4095, 4096, lineMaxBytes - 16, 4 * lineMaxBytes} {
		p := testPane()
		p.running = true
		input := "begin:" + strings.Repeat("中🦀", size/7) + ":end"
		drain(p, strings.NewReader(input), "stdout")
		out, _ := p.ResultText()
		screen, running, _, _ := p.snapshot()
		for _, got := range []string{out, screen} {
			if !utf8.ValidString(got) || strings.Contains(got, "�") || len(got) > lineMaxBytes || !strings.HasPrefix(got, "begin:") || !strings.HasSuffix(got, ":end") {
				t.Fatalf("size=%d: invalid bounded output of %d bytes", size, len(got))
			}
			if len(input) <= lineMaxBytes && got != input {
				t.Fatalf("size=%d: truncated output within original budget", size)
			}
		}
		if !running {
			t.Fatal("drain changed task lifecycle")
		}
	}
}
