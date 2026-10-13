package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"
)

func guardIdle(a *Agent) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.isIdleLocked()
}

func waitGuardIdle(t *testing.T, a *Agent) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if guardIdle(a) {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("work reservation leaked")
}

func TestAutoUpdateCommitRequiresIdleAndConsent(t *testing.T) {
	cases := []struct {
		name string
		busy func(*Agent)
	}{
		{"plugin_or_delivery", func(a *Agent) { a.activeWork++ }},
		{"run_admission", func(a *Agent) { a.runAdmissions = map[string]int{"request": 1} }},
		{"pending", func(a *Agent) { a.pending = &Pending{} }},
		{"desktop_pending", func(a *Agent) { a.desktopPending = &Pending{} }},
		{"peer", func(a *Agent) { a.peerSessions = map[string]*pluginPeerSession{"session": {}} }},
		{"peer_cleanup", func(a *Agent) { a.peerCancelRecovery = map[string]*pluginPeerSession{"session": {}} }},
		{"restarting", func(a *Agent) { a.restarting = true }},
		{"committing", func(a *Agent) { a.updateCommitting = true }},
		{"toggle_off", func(a *Agent) { a.autoUpdate = false }},
		{"disabled", func(a *Agent) { a.enabled = false }},
		{"revoked", func(a *Agent) { a.authRevoked = true }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := &Agent{autoUpdate: true, enabled: true}
			tc.busy(a)
			if a.beginAutoUpdateCommit() {
				t.Fatal("automatic update entered while blocked")
			}
		})
	}
}

func TestAutoUpdateAdmissionAtomic(t *testing.T) {
	for i := 0; i < 1000; i++ {
		a := &Agent{autoUpdate: true, enabled: true}
		start := make(chan struct{})
		var task, update bool
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); <-start; task = a.beginWork() }()
		go func() { defer wg.Done(); <-start; update = a.beginAutoUpdateCommit() }()
		close(start)
		wg.Wait()
		if task == update {
			t.Fatalf("exactly one must enter: task=%v update=%v", task, update)
		}
		if task {
			a.finishWork()
		} else {
			a.endAutoUpdateCommit()
		}
		if !guardIdle(a) {
			t.Fatal("failed to release admission")
		}
	}
}

func TestAutoUpdateCommitRefusesTasksButAllowsQueries(t *testing.T) {
	t.Setenv("FLEET_HOME", t.TempDir())
	a := &Agent{autoUpdate: true, enabled: true, permit: PermitAllow}
	if !a.beginAutoUpdateCommit() {
		t.Fatal("idle update refused")
	}
	defer a.endAutoUpdateCommit()
	for _, tc := range []struct{ request, reply string }{
		{"run", "result"}, {"type", "typed"}, {"plugin", "plugin_result"},
		{"desktop_screenshot", "desktop"}, {"desktop_action", "desktop"},
	} {
		replies := make(chan Envelope, 1)
		a.dispatchEnvelope(context.Background(), func(_ context.Context, env Envelope) error {
			replies <- env
			return nil
		}, Envelope{Type: tc.request, Corr: "not-started", Body: map[string]any{"command": "echo should-not-run", "request_id": "not-started"}})
		got := receivePluginEnvelope(t, replies)
		if got.Type != tc.reply || got.Corr != "not-started" || got.Body["ok"] != false {
			t.Fatalf("invalid refusal: %+v", got)
		}
	}
	if len(a.operations) != 0 || len(a.runAdmissions) != 0 || a.activeWork != 0 {
		t.Fatal("refused request created execution state")
	}
	replies := make(chan Envelope, 1)
	a.dispatchEnvelope(context.Background(), func(_ context.Context, env Envelope) error {
		replies <- env
		return nil
	}, Envelope{Type: "get_result", Corr: "query", Body: map[string]any{"corr": "existing"}})
	got := receivePluginEnvelope(t, replies)
	if got.Type != "result" || got.Corr != "existing" {
		t.Fatalf("query unavailable during commit: %+v", got)
	}
}

func TestAutoUpdateTracksPluginThroughApprovalAndDelivery(t *testing.T) {
	for _, permit := range []Permit{PermitAllow, PermitAsk} {
		t.Run(string(permit), func(t *testing.T) {
			installPluginTestBinary(t)
			original := invokePluginTask
			defer func() { invokePluginTask = original }()
			invoked, finish := make(chan struct{}), make(chan struct{})
			delivering, delivered := make(chan struct{}), make(chan struct{})
			var finishOnce, deliverOnce sync.Once
			defer finishOnce.Do(func() { close(finish) })
			defer deliverOnce.Do(func() { close(delivered) })
			invokePluginTask = func(context.Context, pluginRequest) (any, error) {
				close(invoked)
				<-finish
				return "done", nil
			}
			a := &Agent{autoUpdate: true, enabled: true, permit: permit}
			a.dispatchEnvelope(context.Background(), func(_ context.Context, env Envelope) error {
				if env.Type == "plugin_result" {
					close(delivering)
					<-delivered
				}
				return nil
			}, pluginInvokeEnvelope())
			if a.beginAutoUpdateCommit() {
				t.Fatal("updated after accepting plugin")
			}
			if permit == PermitAsk {
				a.approve()
			}
			select {
			case <-invoked:
			case <-time.After(3 * time.Second):
				t.Fatal("plugin not invoked")
			}
			if a.beginAutoUpdateCommit() {
				t.Fatal("updated while plugin executing")
			}
			finishOnce.Do(func() { close(finish) })
			select {
			case <-delivering:
			case <-time.After(3 * time.Second):
				t.Fatal("result not delivered")
			}
			if a.beginAutoUpdateCommit() {
				t.Fatal("updated before plugin result delivered")
			}
			deliverOnce.Do(func() { close(delivered) })
			waitGuardIdle(t, a)
			if !a.beginAutoUpdateCommit() {
				t.Fatal("did not become updateable after completion")
			}
			a.endAutoUpdateCommit()
		})
	}
}

func TestAutoUpdateCommitPreservesReceipts(t *testing.T) {
	for _, state := range []string{"done", "unknown", "conflict", "disk"} {
		t.Run(state, func(t *testing.T) {
			a := operationAgent(t)
			a.updateCommitting = true
			cmd, corr, fp := "printf original", "original", "owner"
			key, path := a.operationKey(corr, fp)
			row := &operationReceipt{Version: 1, Input: digestOperation(cmd), Status: "done", Code: 7}
			if state == "unknown" {
				row.Status = "unknown"
			}
			if state == "disk" {
				if err := writeOperation(path, *row, true); err != nil {
					t.Fatal(err)
				}
			} else {
				a.operations = map[string]*operationReceipt{key: row}
			}
			if state == "conflict" {
				cmd = "printf different"
			}
			sink, replies := captureOperation()
			a.dispatchEnvelope(context.Background(), sink, Envelope{Type: "run", Corr: corr, Body: map[string]any{
				"command": cmd, "request_id": corr, "fingerprint": fp,
			}})
			got := receivePluginEnvelope(t, replies)
			switch state {
			case "unknown", "conflict":
				if got.Body["status"] != state {
					t.Fatalf("lost %s evidence: %+v", state, got)
				}
			default:
				if got.Body["exit_code"] != 7 || got.Body["output_unavailable"] != true {
					t.Fatalf("lost completed receipt: %+v", got)
				}
			}
			if a.activeWork != 0 || len(a.runAdmissions) != 0 {
				t.Fatal("duplicate admitted for execution")
			}
		})
	}
}

// Invalid archive bytes are deliberate: a deferred update must never reach
// staging/live-file replacement. No executable is installed by these tests.
func TestAutoUpdateRechecksAfterDownload(t *testing.T) {
	for _, change := range []string{"task", "toggle_off", "disabled", "revoked", "staging_failure"} {
		t.Run(change, func(t *testing.T) {
			if runtime.GOOS == "windows" && change == "staging_failure" {
				t.Skip("Windows raw EXE staging does not validate archive structure")
			}
			home := t.TempDir()
			t.Setenv("FLEET_HOME", home)
			a := &Agent{autoUpdate: true, enabled: true}
			name := releaseAssetNames(runtime.GOOS, runtime.GOARCH)[0]
			const body = "intentionally not an executable archive"
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/"+name {
					fmt.Fprintf(w, "%s  %s\n", sha256Hex(body), name)
					return
				}
				a.mu.Lock()
				switch change {
				case "task":
					a.activeWork++
				case "toggle_off":
					a.autoUpdate = false
				case "disabled":
					a.enabled = false
				case "revoked":
					a.authRevoked = true
				}
				a.mu.Unlock()
				fmt.Fprint(w, body)
			}))
			defer server.Close()
			t.Setenv("FLEET_UPDATE_BASE", server.URL)
			t.Setenv("FLEET_UPDATE_API", "")
			err := applyUpdate(a, updateRequest{Auto: true, VersionHint: "99.0.0"})
			if change == "staging_failure" {
				if err == nil {
					t.Fatal("invalid archive must fail staging")
				}
			} else if err != nil || updateStatus().Phase != "available" {
				t.Fatalf("must defer before staging: err=%v status=%+v", err, updateStatus())
			}
			if a.updateCommitting || a.restarting || !a.beginWork() {
				t.Fatal("failed/deferred update left admission closed")
			}
			a.finishWork()
			if _, err := os.Stat(filepath.Join(home, "updates", name)); !os.IsNotExist(err) {
				t.Fatalf("download not cleaned: %v", err)
			}
		})
	}
}
