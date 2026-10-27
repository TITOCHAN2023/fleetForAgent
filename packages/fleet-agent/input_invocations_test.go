package main

import (
	"context"
	"testing"
	"time"

	"github.com/TITOCHAN2023/fleetForAgent/internal/receipts"
)

func inputTestContext(actor string) context.Context {
	return context.WithValue(context.Background(), pluginPrincipalKey{}, actor)
}

func TestDesktopInputReceiptSurvivesRestartAndRejectsDifferentCaller(t *testing.T) {
	dir := t.TempDir()
	ledger, err := receipts.Open(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	backend := &fakeDesk{}
	a := &Agent{enabled: true, permit: PermitAllow, backend: backend, invocationReceipts: ledger}
	env := Envelope{Type: "desktop_action", Corr: "input-retry", Body: map[string]any{"action": "type", "text": "private input fixture"}}
	var reply Envelope
	sink := func(_ context.Context, e Envelope) error { reply = e; return nil }
	a.dispatchInput(inputTestContext("owner"), sink, env)
	a.dispatchInput(inputTestContext("owner"), sink, env)
	if len(backend.typed) != 1 || reply.Body["ok"] != true {
		t.Fatalf("duplicate input: %+v %+v", backend.typed, reply)
	}
	ledger.Close()
	ledger, err = receipts.Open(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	other := &fakeDesk{}
	restarted := &Agent{enabled: true, permit: PermitAllow, backend: other, invocationReceipts: ledger}
	restarted.dispatchInput(inputTestContext("owner"), sink, env)
	if len(other.typed) != 0 || reply.Body["ok"] != true {
		t.Fatal("restarted input executed again")
	}
	restarted.dispatchInput(inputTestContext("different-owner"), sink, env)
	if reply.Body["code"] != "RECEIPT_REJECTED" || len(other.typed) != 0 {
		t.Fatal("caller reused receipt")
	}
}

func TestDesktopConsentReceiptAllowsSameRequestAfterApproval(t *testing.T) {
	ledger, err := receipts.Open(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	backend := &fakeDesk{}
	a := &Agent{enabled: true, permit: PermitAsk, backend: backend, invocationReceipts: ledger}
	env := Envelope{Type: "desktop_action", Corr: "consent-retry", Body: map[string]any{"action": "type", "text": "private input fixture"}}
	var reply Envelope
	sink := func(_ context.Context, e Envelope) error { reply = e; return nil }
	a.dispatchInput(inputTestContext("owner"), sink, env)
	if reply.Body["status"] != "consent" || len(backend.typed) != 0 {
		t.Fatal("input before consent")
	}
	a.approve()
	a.dispatchInput(inputTestContext("owner"), sink, env)
	a.dispatchInput(inputTestContext("owner"), sink, env)
	if reply.Body["ok"] != true || len(backend.typed) != 1 {
		t.Fatal("consent retry lost or repeated input")
	}
}

type blockedInputBackend struct {
	fakeDesk
	started, release chan struct{}
}

func (b *blockedInputBackend) TypeText(string) error {
	close(b.started)
	<-b.release
	return nil
}
func TestUnknownInputReceiptAfterRestartNeverRepeatsSideEffect(t *testing.T) {
	dir := t.TempDir()
	ledger, err := receipts.Open(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	backend := &blockedInputBackend{started: make(chan struct{}), release: make(chan struct{})}
	a := &Agent{enabled: true, permit: PermitAllow, backend: backend, invocationReceipts: ledger}
	env := Envelope{Type: "desktop_action", Corr: "unknown-input", Body: map[string]any{"action": "type", "text": "fixture"}}
	done := make(chan struct{})
	go func() {
		a.dispatchInput(inputTestContext("owner"), func(context.Context, Envelope) error { return nil }, env)
		close(done)
	}()
	select {
	case <-backend.started:
	case <-time.After(time.Second):
		t.Fatal("input did not start")
	}
	defer func() { close(backend.release); <-done }()
	ledger.Close()
	reopened, err := receipts.Open(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	other := &fakeDesk{}
	restarted := &Agent{enabled: true, permit: PermitAllow, backend: other, invocationReceipts: reopened}
	var reply Envelope
	restarted.dispatchInput(inputTestContext("owner"), func(_ context.Context, e Envelope) error { reply = e; return nil }, env)
	if reply.Body["code"] != "EXECUTION_INTERRUPTED" || len(other.typed) != 0 {
		t.Fatal("unknown side effect repeated")
	}
}
