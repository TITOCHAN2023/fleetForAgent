//go:build !windows

package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TITOCHAN2023/fleetForAgent/internal/activity"
	"github.com/TITOCHAN2023/fleetForAgent/internal/pane"
	"github.com/TITOCHAN2023/fleetForAgent/internal/receipts"
)

func TestCommandReceiptCompletesAfterTransportLossAndReplaysAfterRestart(t *testing.T) {
	dir := t.TempDir()
	ledger, err := receipts.Open(filepath.Join(dir, "receipts"), nil)
	if err != nil {
		t.Fatal(err)
	}
	journal, err := activity.Open(filepath.Join(dir, "activity"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { journal.Close() })
	path := filepath.Join(dir, "effect")
	quoted := "'" + strings.ReplaceAll(path, "'", "'\\''") + "'"
	env := Envelope{Type: "run", Corr: "command-retry", Body: map[string]any{"command": "printf x >> " + quoted + "; sleep 0.2; printf done"}}
	a := &Agent{enabled: true, permit: PermitAllow, panes: pane.NewSupervisor(), invocationReceipts: ledger, activity: journal}
	t.Cleanup(a.panes.KillAllLive)
	ctx, cancel := context.WithCancel(inputTestContext("owner"))
	defer cancel()
	results := make(chan Envelope, 8)
	sink := func(_ context.Context, e Envelope) error { results <- e; return nil }
	a.dispatchInput(ctx, sink, env)
	select {
	case reply := <-results:
		if reply.Type != "accepted" {
			t.Fatalf("command start failed: %+v", reply)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("command not accepted")
	}
	cancel()
	select {
	case reply := <-results:
		if reply.Type != "result" || reply.Body["ok"] != true {
			t.Fatalf("completion failed: %+v", reply)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("transport loss discarded completion")
	}
	ledger.Close()
	ledger, err = receipts.Open(filepath.Join(dir, "receipts"), nil)
	if err != nil {
		t.Fatal(err)
	}
	restarted := &Agent{enabled: true, permit: PermitAllow, invocationReceipts: ledger}
	restarted.dispatchInput(inputTestContext("owner"), sink, env)
	if reply := <-results; reply.Type != "result" || reply.Body["ok"] != true {
		t.Fatal("stored result not returned")
	}
	b, err := os.ReadFile(path)
	if err != nil || string(b) != "x" || restarted.panes != nil {
		t.Fatal("retry executed command again")
	}
	events := activity.Page{}
	after := uint64(0)
	for {
		page, readErr := journal.Read(activity.Query{Corr: env.Corr, After: after, Limit: 500})
		if readErr != nil {
			t.Fatal(readErr)
		}
		for _, event := range page.Events {
			if event.Source == "core" {
				events.Events = append(events.Events, event)
			}
		}
		if len(page.Events) < 500 {
			break
		}
		after = page.Next
	}
	if err != nil || len(events.Events) != 3 {
		t.Fatalf("missing process evidence: %+v %v", events, err)
	}
	for _, e := range events.Events {
		if e.Actor != "owner" || e.Source != "core" {
			t.Fatal("process identity changed")
		}
	}
	first, last := events.Events[0], events.Events[2]
	if first.Kind != "process" || first.Phase != "started" || last.Phase != "completed" || first.Details["pid"] != last.Details["pid"] {
		t.Fatal("native process lifecycle not correlated")
	}
}
