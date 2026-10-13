package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Receipts contain identity/input digests and outcome only. Commands, tokens,
// output and environment are NOT persisted. An interrupted intent is unknown,
// never permission to rerun. No expiry silently removes deduplication evidence.
type operationReceipt struct {
	Version    int    `json:"version"`
	Input      string `json:"input"`
	Status     string `json:"status"`
	Code       int    `json:"exit_code"`
	Error      string `json:"-"`
	CreatedAt  int64  `json:"created_at"`
	FinishedAt int64  `json:"finished_at,omitempty"`
}

func digestOperation(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func (a *Agent) operationKey(corr, fp string) (string, string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	// The signed token already binds its hub origin. Cosmetic address edits
	// must not create a second receipt namespace for the same credential.
	namespace := digestOperation(a.hubToken)
	key := digestOperation(namespace + "\x00" + fp + "\x00" + corr)
	if a.cfgPath == "" {
		return key, ""
	}
	return key, filepath.Join(filepath.Dir(a.cfgPath), "operations", key+".json")
}

func readOperation(path string) (*operationReceipt, error) {
	if path == "" {
		return nil, nil
	}
	stat, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !stat.Mode().IsRegular() || stat.Size() > 4096 {
		return nil, fmt.Errorf("unsafe operation receipt")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var row operationReceipt
	if json.Unmarshal(data, &row) != nil || row.Version != 1 || len(row.Input) != 64 || (row.Status != "running" && row.Status != "done") {
		return nil, fmt.Errorf("invalid operation receipt")
	}
	if _, err := hex.DecodeString(row.Input); err != nil {
		return nil, fmt.Errorf("invalid operation input digest")
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || fields["exit_code"] == nil {
		return nil, fmt.Errorf("operation receipt missing exit code")
	}
	if row.Status != "done" {
		row.Status = "unknown"
	}
	return &row, nil
}

func writeOperation(path string, row operationReceipt, create bool) error {
	if path == "" {
		return nil
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	stat, err := os.Lstat(dir)
	if err != nil || !stat.IsDir() || stat.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("unsafe operation directory")
	}
	data, err := json.Marshal(row)
	if err != nil {
		return err
	}
	if create {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		if len(entries) >= 4096 {
			return fmt.Errorf("operation receipt store full; archive reviewed receipts before creating more")
		}
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		if _, err = file.Write(data); err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err != nil {
			return err
		}
		return closeErr
	}
	file, err := os.CreateTemp(dir, ".receipt-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), path)
}

func operationEnv(corr string, row *operationReceipt) Envelope {
	if row == nil || row.Status == "unknown" {
		return Envelope{V: 1, Type: "result", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: corr, T: time.Now().UnixMilli(), Body: map[string]any{
			"status": "unknown", "error": "Execution outcome is unknown. Inspect the device before retrying; Fleet did not rerun the command.",
		}}
	}
	if row.Status == "done" {
		env := resultEnv(corr, row.Code == 0, row.Code, "", row.Error)
		if row.FinishedAt > 0 {
			env.T = row.FinishedAt
		}
		env.Body["output_unavailable"] = true
		return env
	}
	return Envelope{V: 1, Type: "accepted", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: corr, T: time.Now().UnixMilli(), Body: map[string]any{"status": "running", "pane_id": "pane-" + corr}}
}

func (a *Agent) handleRecoverableRun(ctx context.Context, sink EnvelopeSink, corr, cmd, fp string) {
	key, path := a.operationKey(corr, fp)
	input := digestOperation(cmd)
	a.operationMu.Lock()
	if a.operations == nil {
		a.operations = make(map[string]*operationReceipt)
	}
	row := a.operations[key]
	var err error
	if row == nil {
		row, err = readOperation(path)
	}
	if err != nil {
		a.operationMu.Unlock()
		_ = sink(ctx, operationEnv(corr, nil))
		return
	}
	if row != nil {
		a.operations[key] = row
		copy := *row
		a.operationMu.Unlock()
		if copy.Input != input {
			env := resultEnv(corr, false, 126, "", "request_id already used with different command")
			env.Body["status"] = "conflict"
			_ = sink(ctx, env)
			return
		}
		a.replyOperation(ctx, sink, corr, fp, &copy)
		return
	}
	row = &operationReceipt{Version: 1, Input: input, Status: "running", CreatedAt: time.Now().UnixMilli()}
	if err = writeOperation(path, *row, true); err != nil {
		a.operationMu.Unlock()
		_ = sink(ctx, resultEnv(corr, false, 126, "", "cannot persist operation intent; command not started"))
		return
	}
	a.operations[key] = row
	a.operationMu.Unlock()
	tracked := func(sendCtx context.Context, env Envelope) error {
		env.Body["input_hash"] = input
		if env.Type == "result" {
			a.operationMu.Lock()
			row.Status = "done"
			row.FinishedAt = env.T
			if code, ok := env.Body["exit_code"].(int); ok {
				row.Code = code
			}
			row.Error, _ = env.Body["error"].(string)
			persistErr := writeOperation(path, *row, false)
			a.operationMu.Unlock()
			if persistErr != nil {
				// The live result is true, but after restart the original intent
				// will remain unknown. Never claim durable completion on failure.
				env.Body["receipt_error"] = "completion receipt could not be persisted"
			}
		}
		return sink(sendCtx, env)
	}
	a.handleRun(ctx, tracked, corr, cmd, fp)
}

// Reserve before launching the dispatch goroutine. Ordered WS/RTC messages do
// not order goroutine scheduling: a following query must see pending admission,
// not a missing receipt. No I/O or process wait happens on the control loop.
// This is not execution evidence; durable intent is still required before run.
func (a *Agent) admitRun(corr, fp string) func() {
	key, _ := a.operationKey(corr, fp)
	a.mu.Lock()
	if a.runAdmissions == nil {
		a.runAdmissions = make(map[string]int)
	}
	a.runAdmissions[key]++
	a.mu.Unlock()
	return func() {
		a.mu.Lock()
		defer a.mu.Unlock()
		a.runAdmissions[key]--
		if a.runAdmissions[key] == 0 {
			delete(a.runAdmissions, key)
		}
	}
}

func (a *Agent) replyOperation(ctx context.Context, sink EnvelopeSink, corr, fp string, row *operationReceipt) {
	a.mu.Lock()
	sup := a.panes
	a.mu.Unlock()
	if sup != nil && row != nil && row.Status != "unknown" {
		if p := sup.GetFor(fp, corr); p != nil {
			if done, code := p.Finished(); done {
				stdout, stderr := p.ResultText()
				env := resultEnv(corr, code == 0, code, stdout, stderr)
				if row.Input != "" {
					env.Body["input_hash"] = row.Input
				}
				_ = sink(ctx, env)
				return
			}
		}
	}
	env := operationEnv(corr, row)
	if row != nil && row.Input != "" {
		env.Body["input_hash"] = row.Input
	}
	_ = sink(ctx, env)
}

func (a *Agent) handleResultQuery(ctx context.Context, sink EnvelopeSink, env Envelope) {
	corr, _ := env.Body["corr"].(string)
	if strings.TrimSpace(corr) == "" {
		corr = env.Corr
	}
	if corr == "" {
		return
	}
	fp := envelopeFingerprint(env.Body)
	key, path := a.operationKey(corr, fp)
	// Snapshot admission first: its release happens only after receipt/pane
	// creation. Reading in the opposite order could miss both generations.
	a.mu.Lock()
	sup := a.panes
	admitted := a.runAdmissions[key] > 0
	a.mu.Unlock()
	a.operationMu.Lock()
	row := a.operations[key]
	var readErr error
	if row == nil {
		row, readErr = readOperation(path)
	}
	if row != nil {
		copy := *row
		row = &copy
	}
	a.operationMu.Unlock()
	if row == nil && readErr == nil && admitted {
		row = &operationReceipt{Status: "running"}
	}
	// Legacy jobs have no disk receipt but are still queryable while alive.
	if row == nil && sup != nil && sup.GetFor(fp, corr) != nil {
		row = &operationReceipt{Status: "running"}
	}
	a.replyOperation(ctx, sink, corr, fp, row)
}
