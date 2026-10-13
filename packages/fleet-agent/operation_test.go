package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/TITOCHAN2023/fleetForAgent/internal/pane"
)

func operationAgent(t *testing.T) *Agent {
	t.Helper()
	return &Agent{enabled: true, permit: PermitAllow, cfgPath: filepath.Join(t.TempDir(), "config.json"), hubInput: "https://test.invalid", hubToken: "test-secret", panes: pane.NewSupervisor()}
}

func captureOperation() (EnvelopeSink, <-chan Envelope) {
	replies := make(chan Envelope, 128)
	return func(_ context.Context, env Envelope) error { replies <- env; return nil }, replies
}

func TestOperationLabEvictedOutputKeepsReceiptAndNeverReplays(t *testing.T) {
	if os.Getenv("FLEET_OPERATION_LAB") != "1" {
		t.Skip("disposable VM/container only")
	}
	a := operationAgent(t)
	sink, replies := captureOperation()
	counter := filepath.Join(t.TempDir(), "counter")
	command := "echo once >> " + counter + "; printf private-output; exit 7"
	a.handleRecoverableRun(context.Background(), sink, "original", command, "owner")
	awaitOperation(t, replies, "result")
	for i := 0; i < 256; i++ {
		a.handleRecoverableRun(context.Background(), sink, fmt.Sprintf("filler-%d", i), "printf ok", "other")
		awaitOperation(t, replies, "result")
	}
	if a.panes.GetFor("owner", "original") != nil {
		t.Fatal("old output did not leave the memory cache")
	}
	a.operationMu.Lock()
	a.operations = nil // force proof from disk, not the in-memory receipt cache
	a.operationMu.Unlock()
	a.handleResultQuery(context.Background(), sink, Envelope{Corr: "original", Body: map[string]any{"fingerprint": "owner"}})
	got := awaitOperation(t, replies, "result")
	if got.Body["exit_code"] != 7 || got.Body["output_unavailable"] != true || got.Body["stdout"] != "" {
		t.Fatalf("eviction lost execution evidence: %+v", got)
	}
	a.handleRecoverableRun(context.Background(), sink, "original", command, "owner")
	got = awaitOperation(t, replies, "result")
	data, err := os.ReadFile(counter)
	if err != nil || string(data) != "once\n" || got.Body["output_unavailable"] != true {
		t.Fatalf("evicted command replayed: data=%q err=%v result=%+v", data, err, got)
	}
	a.handleResultQuery(context.Background(), sink, Envelope{Corr: "original", Body: map[string]any{"fingerprint": "other"}})
	if foreign := awaitOperation(t, replies, "result"); foreign.Body["status"] != "unknown" {
		t.Fatal("eviction exposed another operator's receipt")
	}
}

func TestRunAdmissionPreventsFalseUnknownAndRemainsScoped(t *testing.T) {
	a := operationAgent(t)
	first, second := a.admitRun("corr", "owner"), a.admitRun("corr", "owner")
	sink, replies := captureOperation()
	query := func(fp string) Envelope {
		a.handleResultQuery(context.Background(), sink, Envelope{Corr: "corr", Body: map[string]any{"fingerprint": fp}})
		return <-replies
	}
	if got := query("owner"); got.Type != "accepted" {
		t.Fatalf("admitted run became unknown: %+v", got)
	}
	if got := query("other"); got.Body["status"] != "unknown" {
		t.Fatalf("foreign operator saw admission: %+v", got)
	}
	first()
	if got := query("owner"); got.Type != "accepted" {
		t.Fatalf("one duplicate removed another admission: %+v", got)
	}
	second()
	if got := query("owner"); got.Body["status"] != "unknown" {
		t.Fatalf("missing durable evidence became success: %+v", got)
	}
	if len(a.runAdmissions) != 0 || len(a.panes.List()) != 0 {
		t.Fatal("admission leaked or executed a command")
	}
}

func TestDispatchAdmitsRunBeforeAsyncReceiptCreation(t *testing.T) {
	a := operationAgent(t)
	a.permit = PermitOff
	a.operationMu.Lock()
	sink, replies := captureOperation()
	a.dispatchEnvelope(context.Background(), sink, Envelope{Type: "run", Corr: "corr", Body: map[string]any{
		"fingerprint": "owner", "request_id": "request", "command": "never execute",
	}})
	key, _ := a.operationKey("corr", "owner")
	a.mu.Lock()
	admissions := a.runAdmissions[key]
	a.mu.Unlock()
	a.operationMu.Unlock()
	if admissions != 1 {
		t.Fatalf("dispatch returned before registering admission: %d", admissions)
	}
	got := awaitOperation(t, replies, "result")
	if got.Body["exit_code"] != 126 {
		t.Fatalf("admission bypassed device policy: %+v", got)
	}
}

func awaitOperation(t *testing.T, replies <-chan Envelope, kind string) Envelope {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case env := <-replies:
			if env.Type == kind {
				return env
			}
		case <-timer.C:
			t.Fatalf("missing %s", kind)
		}
	}
}

func TestOperationInterruptedIntentIsUnknownAndNeverRerun(t *testing.T) {
	a := operationAgent(t)
	_, path := a.operationKey("operation-1", "operator-1")
	row := operationReceipt{Version: 1, Input: digestOperation("echo never-run"), Status: "running"}
	if err := writeOperation(path, row, true); err != nil {
		t.Fatal(err)
	}
	sink, replies := captureOperation()
	a.handleRecoverableRun(context.Background(), sink, "operation-1", "echo never-run", "operator-1")
	got := awaitOperation(t, replies, "result")
	if got.Body["status"] != "unknown" || len(a.panes.List()) != 0 {
		t.Fatalf("unsafe recovery %#v", got)
	}
}

func TestOperationDoneReceiptSurvivesRestartWithoutSecrets(t *testing.T) {
	a := operationAgent(t)
	_, path := a.operationKey("operation-1", "operator-1")
	row := operationReceipt{Version: 1, Input: digestOperation("echo sensitive-command"), Status: "done", Code: 7, Error: "sensitive-output"}
	if err := writeOperation(path, row, true); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "sensitive") || strings.Contains(string(data), a.hubToken) {
		t.Fatal("receipt leaked raw data")
	}
	sink, replies := captureOperation()
	a.handleResultQuery(context.Background(), sink, Envelope{Body: map[string]any{"corr": "operation-1", "fingerprint": "operator-1"}})
	got := awaitOperation(t, replies, "result")
	if got.Body["exit_code"] != 7 || got.Body["output_unavailable"] != true {
		t.Fatalf("restart result %#v", got)
	}
}

func TestOperationReceiptIsIsolatedByOperatorAndToken(t *testing.T) {
	a := operationAgent(t)
	key, path := a.operationKey("same-id", "operator-1")
	otherKey, otherPath := a.operationKey("same-id", "operator-2")
	if key == otherKey || path == otherPath {
		t.Fatal("operators share receipts")
	}
	a.hubToken = "rotated-secret"
	rotated, _ := a.operationKey("same-id", "operator-1")
	if key == rotated {
		t.Fatal("token rotation reused receipt namespace")
	}
}

func TestOperationCorruptReceiptFailsClosed(t *testing.T) {
	a := operationAgent(t)
	_, path := a.operationKey("operation-1", "operator-1")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{broken"), 0600); err != nil {
		t.Fatal(err)
	}
	sink, replies := captureOperation()
	a.handleRecoverableRun(context.Background(), sink, "operation-1", "echo never-run", "operator-1")
	got := awaitOperation(t, replies, "result")
	if got.Body["status"] != "unknown" || len(a.panes.List()) != 0 {
		t.Fatalf("corrupt receipt allowed execution %#v", got)
	}
}

func TestOperationPolicyStillRefusesWithoutSpawn(t *testing.T) {
	for _, tc := range []struct {
		name    string
		permit  Permit
		blocked bool
	}{
		{"off", PermitOff, false}, {"destructive", PermitAllow, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := operationAgent(t)
			a.permit = tc.permit
			a.policyBlocked = func(string) bool { return tc.blocked }
			sink, replies := captureOperation()
			a.handleRecoverableRun(context.Background(), sink, "operation-1", "echo safe-placeholder", "operator-1")
			got := awaitOperation(t, replies, "result")
			if got.Body["ok"] != false || len(a.panes.List()) != 0 {
				t.Fatalf("policy bypass %#v", got)
			}
		})
	}
}

func TestOperationDifferentInputIsConflictNotAnotherExecution(t *testing.T) {
	a := operationAgent(t)
	key, path := a.operationKey("operation-1", "operator-1")
	row := operationReceipt{Version: 1, Input: digestOperation("original"), Status: "done"}
	if err := writeOperation(path, row, true); err != nil {
		t.Fatal(err)
	}
	sink, replies := captureOperation()
	a.handleRecoverableRun(context.Background(), sink, "operation-1", "different", "operator-1")
	got := awaitOperation(t, replies, "result")
	if got.Body["status"] != "conflict" || a.operations[key].Input != row.Input || len(a.panes.List()) != 0 {
		t.Fatalf("bad conflict %#v", got)
	}
}

func TestOperationUnavailableStoreNeverStartsCommand(t *testing.T) {
	a := operationAgent(t)
	if err := os.WriteFile(filepath.Join(filepath.Dir(a.cfgPath), "operations"), []byte("not a directory"), 0600); err != nil {
		t.Fatal(err)
	}
	sink, replies := captureOperation()
	a.handleRecoverableRun(context.Background(), sink, "operation-1", "echo never-run", "operator-1")
	got := awaitOperation(t, replies, "result")
	// An unreadable prior receipt is unknown, not proof of safe failure.
	if got.Body["status"] != "unknown" || len(a.panes.List()) != 0 {
		t.Fatalf("write failure allowed execution %#v", got)
	}
}

func TestOperationPartialDoneReceiptCannotInventSuccess(t *testing.T) {
	a := operationAgent(t)
	_, path := a.operationKey("operation-1", "operator-1")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	data := []byte(`{"version":1,"input":"` + digestOperation("echo safe") + `","status":"done"}`)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if row, err := readOperation(path); row != nil || err == nil {
		t.Fatalf("partial completion accepted %#v %v", row, err)
	}
}

func TestOperationRecoveryEnvelopesKeepWireMetadata(t *testing.T) {
	for _, row := range []*operationReceipt{nil, {Status: "unknown"}, {Status: "running"}} {
		env := operationEnv("operation-1", row)
		if env.V != 1 || env.ID == "" || env.Corr != "operation-1" || env.T <= 0 {
			t.Fatalf("incomplete wire envelope %#v", env)
		}
	}
}

// Real child processes belong in the disposable container, never the user's
// running Fleet Agent. Enable only in scripts/test-agent-sandbox.sh.
func TestOperationLabDuplicateConcurrentDeliveryRunsOnce(t *testing.T) {
	if os.Getenv("FLEET_OPERATION_LAB") != "1" {
		t.Skip("container-only process test")
	}
	a := operationAgent(t)
	counter := filepath.Join(t.TempDir(), "counter.txt")
	command := "echo once >> \"" + counter + "\""
	sink, replies := captureOperation()
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a.handleRecoverableRun(context.Background(), sink, "operation-1", command, "operator-1")
		}()
	}
	wg.Wait()
	awaitOperation(t, replies, "result")
	data, err := os.ReadFile(counter)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(data), "once") != 1 {
		t.Fatalf("duplicate side effect %q", data)
	}
	if len(a.panes.List()) != 1 {
		t.Fatal("duplicate panes")
	}
}

func TestOperationLabLostTransportStillPersistsCompletion(t *testing.T) {
	if os.Getenv("FLEET_OPERATION_LAB") != "1" {
		t.Skip("container-only process test")
	}
	a := operationAgent(t)
	ctx, cancel := context.WithCancel(context.Background())
	sink, replies := captureOperation()
	a.handleRecoverableRun(ctx, sink, "operation-1", "sleep 0.2; echo recovered; exit 3", "operator-1")
	awaitOperation(t, replies, "accepted")
	cancel()
	got := awaitOperation(t, replies, "result")
	if got.Body["exit_code"] != 3 || !strings.Contains(got.Body["stdout"].(string), "recovered") {
		t.Fatalf("lost completion %#v", got)
	}
	_, path := a.operationKey("operation-1", "operator-1")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var row operationReceipt
	if err := json.Unmarshal(data, &row); err != nil {
		t.Fatal(err)
	}
	if row.Status != "done" || row.Code != 3 {
		t.Fatalf("completion not durable %#v", row)
	}
	querySink, queryReplies := captureOperation()
	a.handleResultQuery(context.Background(), querySink, Envelope{Body: map[string]any{"corr": "operation-1", "fingerprint": "operator-1"}})
	queried := awaitOperation(t, queryReplies, "result")
	if queried.Body["exit_code"] != 3 || queried.Body["stdout"] != got.Body["stdout"] {
		t.Fatalf("device query %#v", queried)
	}
}
