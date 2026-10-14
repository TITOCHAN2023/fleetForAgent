package pane

import (
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

type pausedDestroyHandle struct {
	entered chan struct{}
	release chan struct{}
}

func (h *pausedDestroyHandle) Destroy() {
	close(h.entered)
	<-h.release
}

func TestExitKeepsPendingUntilOldShellIsDestroyed(t *testing.T) {
	s := NewSupervisor()
	p := registeredPane(s, "exit-a", "owner")
	job := &liveJob{pane: p, command: "exit"}
	h := &pausedDestroyHandle{entered: make(chan struct{}), release: make(chan struct{})}
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(h.release) }) })
	// A non-nil but unstarted Cmd represents an alive shell without launching
	// any OS process. Destroy blocks at the exact handoff boundary.
	live := &liveShell{cmd: &exec.Cmd{}, handle: h, rawOut: "A-only\n" + promptPrefix + "0\n"}
	sl := s.slotLocked("owner")
	sl.live, sl.pending = live, job
	done := make(chan bool, 1)
	go func() { done <- s.tryFinishLive("owner", job, live, false) }()
	select {
	case <-h.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("exit did not destroy the old shell")
	}
	s.mu.Lock()
	pending := sl.pending
	s.mu.Unlock()
	if pending != job {
		t.Error("old shell became available before Destroy returned")
	}
	if out, _ := p.ResultText(); out != "A-only" {
		t.Errorf("private completion result=%q", out)
	}
	release.Do(func() { close(h.release) })
	select {
	case finished := <-done:
		if !finished {
			t.Fatal("exit did not complete")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("exit completion blocked")
	}
	s.mu.Lock()
	pending = sl.pending
	s.mu.Unlock()
	if pending != nil || live.alive() {
		t.Fatal("exit did not release pending after teardown")
	}
}

func TestPaneSnapshotOnlyPendingPaneOwnsSharedScreen(t *testing.T) {
	s := NewSupervisor()
	a := registeredPane(s, "a", "owner")
	a.finishCommand("A-only", 0)
	b := registeredPane(s, "b", "owner")
	b.append("stdout", "B-output")
	c := registeredPane(s, "c", "owner")
	c.append("stdout", "C-queued")
	d := registeredPane(s, "d", "other-owner")
	d.append("stdout", "D-other-owner")
	live := &liveShell{screen: newVTScreen(80, 10, nil)}
	live.screen.write([]byte("B-grid"))
	sl := s.slotLocked("owner")
	sl.live, sl.pending, sl.queue = live, &liveJob{pane: b}, []*liveJob{{pane: c}}
	if got := s.TakeDirty(); got != a {
		t.Fatal("expected completed A to be first dirty pane")
	}
	for _, tc := range []struct {
		p    *Pane
		want string
	}{{a, "A-only"}, {b, "B-grid"}, {c, "C-queued"}, {d, "D-other-owner"}} {
		text, _, _, _, _, _ := s.PaneSnapshot(tc.p)
		if text != tc.want {
			t.Errorf("corr=%s screen=%q want=%q", tc.p.corr, text, tc.want)
		}
	}
	// A finished pane must stay private even while pending cleanup is delayed.
	b.finishCommand("B-finished", 7)
	live.screen.resetPrimary()
	live.screen.write([]byte("not-B"))
	text, running, code, _, _, _ := s.PaneSnapshot(b)
	if text != "B-finished" || running || code != 7 {
		t.Fatalf("completed pending pane: %q running=%v code=%d", text, running, code)
	}
}

func TestPaneSnapshotOwnerCheckIsAtomicWithScreenSwitch(t *testing.T) {
	s := NewSupervisor()
	a := registeredPane(s, "a", "owner")
	b := registeredPane(s, "b", "owner")
	a.append("stdout", "A-private")
	b.append("stdout", "B-private")
	live := &liveShell{screen: newVTScreen(80, 10, nil)}
	s.slotLocked("owner").live = live
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 500; i++ {
			p, text := a, "A-grid"
			if i%2 != 0 {
				p, text = b, "B-grid"
			}
			s.mu.Lock()
			live.screen.resetPrimary()
			live.screen.write([]byte(text))
			s.slotLocked("owner").pending = &liveJob{pane: p}
			s.mu.Unlock()
		}
	}()
	for i := 0; i < 500; i++ {
		for _, p := range []*Pane{a, b} {
			text, _, _, _, _, _ := s.PaneSnapshot(p)
			prefix := strings.ToUpper(p.corr) + "-"
			if !strings.HasPrefix(text, prefix) {
				t.Errorf("corr=%s received other task text %q", p.corr, text)
				wg.Wait()
				return
			}
		}
	}
	wg.Wait()
}
