package pane

import (
	"fmt"
	"sync"
	"testing"
)

func registeredPane(s *Supervisor, corr, owner string) *Pane {
	p := &Pane{id: "pane-" + corr, corr: corr, fingerprint: owner, running: true}
	s.mu.Lock()
	s.registerLocked(p)
	s.mu.Unlock()
	return p
}

func TestCompletedRetentionKeepsRunningAndQueuedPanes(t *testing.T) {
	s := NewSupervisor()
	active := registeredPane(s, "active", "owner")
	queued := registeredPane(s, "queued", "other")
	active.retainCompletion() // even an erroneous early notification cannot evict it
	first := registeredPane(s, "first", "owner")
	first.finishCommand("still deliver this output", 7)
	for i := 0; i < 4*completedPaneLimit; i++ {
		registeredPane(s, fmt.Sprint(i), "other").finishCommand("result", 0)
	}
	if s.GetFor("owner", "active") != active || s.GetFor("other", "queued") != queued {
		t.Fatal("running or queued task was evicted")
	}
	if s.GetFor("owner", "first") != nil || s.GetFor("owner", "pane-first") != nil {
		t.Fatal("evicted pane remains addressable through an alias")
	}
	if out, _ := first.ResultText(); out != "still deliver this output" {
		t.Fatal("in-flight delivery lost its output")
	}
	if len(s.completed) != completedPaneLimit || len(s.order) != completedPaneLimit+2 || len(s.panes) != 2*(completedPaneLimit+2) {
		t.Fatalf("unbounded indexes: completed=%d order=%d aliases=%d", len(s.completed), len(s.order), len(s.panes))
	}
	if s.GetFor("owner", "1023") != nil || s.GetFor("other", "") == nil {
		t.Fatal("retention changed operator isolation or latest lookup")
	}
}

func TestRetentionUsesCompletionOrderNotStartOrder(t *testing.T) {
	s := NewSupervisor()
	oldRunning := registeredPane(s, "old-running", "owner")
	for i := 0; i < completedPaneLimit; i++ {
		registeredPane(s, fmt.Sprint(i), "owner").finishCommand("done", 0)
	}
	oldRunning.finishCommand("finished last", 0)
	oldRunning.retainCompletion() // duplicate notifications do not consume capacity
	if s.GetFor("owner", "0") != nil || s.GetFor("owner", "old-running") != oldRunning || len(s.completed) != completedPaneLimit {
		t.Fatal("retention did not follow completion order")
	}
}

func TestRetentionConcurrentCompletionAndReaders(t *testing.T) {
	s := NewSupervisor()
	var wg sync.WaitGroup
	for i := 0; i < 1024; i++ {
		p := registeredPane(s, fmt.Sprint(i), fmt.Sprint(i%4))
		wg.Add(1)
		go func() {
			defer wg.Done()
			p.finishCommand("done", 0)
			s.GetFor(p.fingerprint, p.corr)
			s.List()
		}()
	}
	wg.Wait()
	if len(s.completed) != completedPaneLimit || len(s.order) != completedPaneLimit || len(s.panes) != 2*completedPaneLimit {
		t.Fatal("concurrent completion left an unbounded cache")
	}
}
