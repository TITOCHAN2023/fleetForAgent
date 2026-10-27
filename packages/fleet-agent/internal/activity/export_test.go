package activity

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/TITOCHAN2023/fleetForAgent/internal/vault"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type blockingExportWriter struct {
	once             sync.Once
	entered, release chan struct{}
	buf              bytes.Buffer
}

func newBlockingExportWriter() *blockingExportWriter {
	return &blockingExportWriter{entered: make(chan struct{}), release: make(chan struct{})}
}
func (w *blockingExportWriter) Write(b []byte) (int, error) {
	w.once.Do(func() { close(w.entered); <-w.release })
	return w.buf.Write(b)
}
func waitExport(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		t.Fatal("export did not reach writer")
	}
}
func appendWhileExportBlocked(t *testing.T, s *Store) {
	t.Helper()
	ch := make(chan error, 1)
	go func() { ch <- s.Append(Event{Kind: "process", Summary: "appended while HTTP writer blocked"}) }()
	select {
	case e := <-ch:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(time.Second):
		t.Fatal("remote writer blocked Append")
	}
}
func TestExportSlowWriterDoesNotOwnJournal(t *testing.T) {
	for _, encrypted := range []bool{false, true} {
		t.Run(map[bool]string{false: "plain", true: "encrypted"}[encrypted], func(t *testing.T) {
			var c *vault.Cipher
			if encrypted {
				c, _ = vault.New(bytes.Repeat([]byte{42}, 32))
			}
			s, e := OpenEncrypted(t.TempDir(), c)
			if e != nil {
				t.Fatal(e)
			}
			defer s.Close()
			for i := 0; i < 3; i++ {
				if e := s.Append(Event{Kind: "process", Summary: "sensitive metadata"}); e != nil {
					t.Fatal(e)
				}
			}
			w := newBlockingExportWriter()
			done := make(chan error, 1)
			go func() { done <- s.Export(context.Background(), w) }()
			waitExport(t, w.entered)
			appendWhileExportBlocked(t, s)
			if e := s.Export(context.Background(), io.Discard); !errors.Is(e, ErrExportBusy) {
				t.Fatal("missing concurrent export gate", e)
			}
			close(w.release)
			if e := <-done; e != nil {
				t.Fatal(e)
			}
			dec := json.NewDecoder(bytes.NewReader(w.buf.Bytes()))
			for seq := uint64(1); seq <= 3; seq++ {
				var event Event
				if e := dec.Decode(&event); e != nil || event.Seq != seq {
					t.Fatal("snapshot sequence", event, e)
				}
			}
			var extra Event
			if e := dec.Decode(&extra); e != io.EOF {
				t.Fatal("later append entered snapshot", extra, e)
			}
			if e := s.Export(context.Background(), io.Discard); e != nil {
				t.Fatal("gate not released", e)
			}
			snapshot, e := s.SnapshotForExport(context.Background())
			if e != nil {
				t.Fatal(e)
			}
			if encrypted {
				for _, segment := range snapshot.segments {
					if bytes.Contains(segment, []byte("sensitive metadata")) {
						t.Fatal("snapshot contains plaintext")
					}
				}
			}
			snapshot.Close()
		})
	}
}
func TestExportCapturedCipherSurvivesEncryptionChange(t *testing.T) {
	s, e := Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	s.Append(Event{Kind: "process", Summary: "before encryption"})
	w := newBlockingExportWriter()
	done := make(chan error, 1)
	go func() { done <- s.Export(context.Background(), w) }()
	waitExport(t, w.entered)
	c, _ := vault.New(bytes.Repeat([]byte{42}, 32))
	if e := s.EnableEncryption(c); e != nil {
		t.Fatal(e)
	}
	appendWhileExportBlocked(t, s)
	close(w.release)
	if e := <-done; e != nil {
		t.Fatal(e)
	}
	var event Event
	if e := json.Unmarshal(bytes.TrimSpace(w.buf.Bytes()), &event); e != nil || event.Seq != 1 {
		t.Fatal(event, e)
	}
	if e := s.Export(context.Background(), io.Discard); e != nil {
		t.Fatal(e)
	}
}

type failingExportWriter struct{}

func (failingExportWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }
func TestExportGateReleasedOnCancellationAndWriterError(t *testing.T) {
	s, e := Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	s.Append(Event{Kind: "process"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if e := s.Export(ctx, io.Discard); !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
	if e := s.Export(context.Background(), failingExportWriter{}); !errors.Is(e, io.ErrClosedPipe) {
		t.Fatal(e)
	}
	if e := s.Export(context.Background(), io.Discard); e != nil {
		t.Fatal(e)
	}
}

// The fixture is a complete valid near-limit historical segment, written once
// rather than thousands of fsyncs. Export must preserve that captured window
// after Append rotates/deletes its original path.
func writeNearRetentionSegment(t *testing.T, path string, c *vault.Cipher, start uint64) uint64 {
	t.Helper()
	f, e := os.Create(path)
	if e != nil {
		t.Fatal(e)
	}
	w := bufio.NewWriterSize(f, 64<<10)
	size := int64(0)
	seq := start
	for {
		event := Event{Seq: seq, Kind: "process", Summary: strings.Repeat("r", 30000)}
		b, e := encodeEvent(c, event)
		if e != nil {
			t.Fatal(e)
		}
		remaining := int64(segmentBytes-32) - size
		if remaining < int64(len(b)+1) {
			lo, hi := 0, 30000
			for lo < hi {
				mid := (lo + hi + 1) / 2
				event.Summary = strings.Repeat("r", mid)
				trial, e := encodeEvent(c, event)
				if e != nil {
					t.Fatal(e)
				}
				if int64(len(trial)+1) <= remaining {
					lo = mid
				} else {
					hi = mid - 1
				}
			}
			event.Summary = strings.Repeat("r", lo)
			b, e = encodeEvent(c, event)
			if e != nil {
				t.Fatal(e)
			}
			w.Write(append(b, '\n'))
			seq++
			break
		}
		w.Write(append(b, '\n'))
		size += int64(len(b) + 1)
		seq++
	}
	if e := w.Flush(); e != nil {
		t.Fatal(e)
	}
	if e := f.Close(); e != nil {
		t.Fatal(e)
	}
	return seq - 1
}

type sequenceExportWriter struct {
	once             sync.Once
	entered, release chan struct{}
	last             uint64
}

func (w *sequenceExportWriter) Write(b []byte) (int, error) {
	w.once.Do(func() { close(w.entered); <-w.release })
	var e Event
	if err := json.Unmarshal(b, &e); err != nil {
		return 0, err
	}
	if w.last > 0 && e.Seq != w.last+1 {
		return 0, errors.New("noncontiguous snapshot")
	}
	w.last = e.Seq
	return len(b), nil
}
func TestExportRotationPreservesCapturedWindow(t *testing.T) {
	for _, encrypted := range []bool{false, true} {
		t.Run(map[bool]string{false: "plain", true: "encrypted"}[encrypted], func(t *testing.T) {
			dir := t.TempDir()
			name := "events.jsonl"
			var c *vault.Cipher
			if encrypted {
				name = "events.enc.jsonl"
				c, _ = vault.New(bytes.Repeat([]byte{42}, 32))
			}
			first, e := encodeEvent(c, Event{Seq: 1, Kind: "process"})
			if e != nil {
				t.Fatal(e)
			}
			os.WriteFile(filepath.Join(dir, name+".previous"), append(first, '\n'), 0600)
			last := writeNearRetentionSegment(t, filepath.Join(dir, name), c, 2)
			s, e := OpenEncrypted(dir, c)
			if e != nil {
				t.Fatal(e)
			}
			defer s.Close()
			w := &sequenceExportWriter{entered: make(chan struct{}), release: make(chan struct{})}
			done := make(chan error, 1)
			go func() { done <- s.Export(context.Background(), w) }()
			waitExport(t, w.entered)
			appendWhileExportBlocked(t, s)
			if s.currentFirst != last+1 {
				t.Fatal("append did not rotate", s.currentFirst, last)
			}
			close(w.release)
			if e := <-done; e != nil {
				t.Fatal(e)
			}
			if w.last != last {
				t.Fatal("snapshot window changed", w.last, last)
			}
			if e := s.Export(context.Background(), io.Discard); e != nil {
				t.Fatal(e)
			}
		})
	}
}
func TestExportRejectsSymlinkAndOverBoundSnapshot(t *testing.T) {
	s, e := Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	original := s.path + ".old"
	os.Rename(s.path, original)
	if e := os.Symlink(original, s.path); e != nil {
		t.Skip(e)
	}
	if _, e := s.SnapshotForExport(context.Background()); e == nil {
		t.Fatal("symlink accepted")
	}
	os.Remove(s.path)
	os.Rename(original, s.path)
	if e := os.Truncate(s.path, segmentBytes+1); e != nil {
		t.Fatal(e)
	}
	if _, e := s.SnapshotForExport(context.Background()); e == nil {
		t.Fatal("unbounded segment accepted")
	}
	if s.exporting {
		t.Fatal("error leaked snapshot gate")
	}
}
func TestExportCanceledSlowWriterReleasesSnapshot(t *testing.T) {
	s, e := Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	s.Append(Event{Kind: "process"})
	ctx, cancel := context.WithCancel(context.Background())
	w := newBlockingExportWriter()
	done := make(chan error, 1)
	go func() { done <- s.Export(ctx, w) }()
	waitExport(t, w.entered)
	cancel()
	appendWhileExportBlocked(t, s)
	close(w.release)
	if e := <-done; !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
	if e := s.Export(context.Background(), io.Discard); e != nil {
		t.Fatal("cancellation retained gate", e)
	}
}

type panicExportWriter struct{}

func (panicExportWriter) Write([]byte) (int, error) { panic("writer panic") }
func TestExportPanicAndReplacedStoreCannotLeakGlobalBound(t *testing.T) {
	s, e := Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	s.Append(Event{Kind: "process"})
	func() {
		defer func() {
			if recover() == nil {
				t.Error("writer did not panic")
			}
		}()
		s.Export(context.Background(), panicExportWriter{})
	}()
	snapshot, e := s.SnapshotForExport(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	other, e := Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer other.Close()
	if _, e := other.SnapshotForExport(context.Background()); !errors.Is(e, ErrExportBusy) {
		t.Fatal("multiple store snapshots exceeded global memory bound", e)
	}
	snapshot.Close()
	if e := other.Export(context.Background(), io.Discard); e != nil {
		t.Fatal(e)
	}
}
