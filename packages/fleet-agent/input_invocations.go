package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"
)

func inputFailure(request Envelope, code, message string) Envelope {
	switch request.Type {
	case "run":
		r := resultEnv(request.Corr, false, 1, "", message)
		r.Body["code"] = code
		return r
	case "type":
		r := typedEnv(request.Corr, false, message)
		r.Body["code"] = code
		return r
	default:
		return Envelope{V: 1, Type: "desktop", Corr: request.Corr, ID: fmt.Sprintf("%d", time.Now().UnixNano()), T: time.Now().UnixMilli(), Body: map[string]any{"ok": false, "status": "error", "code": code, "error": message}}
	}
}

// Transport retries attach to an existing execution; read_screen/list_panes and
// screenshot remain live reads. Input bytes are hashed, never stored as intent.
func (a *Agent) dispatchInput(ctx context.Context, sink EnvelopeSink, env Envelope) {
	if a.storageLocked.Load() {
		_ = sink(ctx, inputFailure(env, "STORAGE_LOCKED", "fleet: encrypted storage is locked"))
		return
	}
	b, err := json.Marshal(struct {
		Type  string
		Body  map[string]any
		Actor string
	}{env.Type, env.Body, actorFromContext(ctx)})
	if err != nil {
		_ = sink(ctx, inputFailure(env, "BAD_REQUEST", "invalid execution input"))
		return
	}
	sum := sha256.Sum256(b)
	interrupted := inputFailure(env, "EXECUTION_INTERRUPTED", "previous execution outcome unknown after restart; inspect device activity before starting a new task")
	receipt, leader, err := a.claimInvocation(env.Corr, hex.EncodeToString(sum[:]), interrupted)
	if err != nil {
		_ = sink(ctx, inputFailure(env, "RECEIPT_REJECTED", err.Error()))
		return
	}
	if !leader {
		select {
		case <-receipt.Done:
			_ = sink(ctx, receipt.Envelope)
		case <-ctx.Done():
		}
		return
	}
	a.taskMu.Lock()
	receipt.Input = true
	a.taskMu.Unlock()
	wrapped := func(_ context.Context, reply Envelope) error {
		if reply.Type == "result" || reply.Type == "typed" || reply.Type == "desktop" {
			// Desktop consent is a polling response: no mouse/keyboard effect
			// occurred, so the same request may retry after local approval.
			retryable := reply.Type == "desktop" && stringBody(reply.Body, "status") == "consent"
			reply = a.finishInvocation(env.Corr, reply, retryable)
		}
		return sink(ctx, reply)
	}
	switch env.Type {
	case "run":
		a.handleRun(ctx, wrapped, env.Corr, stringBody(env.Body, "command"), envelopeFingerprint(env.Body))
	case "type":
		id := stringBody(env.Body, "pane_id")
		if id == "" {
			id = stringBody(env.Body, "corr")
		}
		a.handleType(ctx, wrapped, env.Corr, id, stringBody(env.Body, "keys"), stringBody(env.Body, "key"), envelopeFingerprint(env.Body))
	case "desktop_action":
		a.handleDesktopAction(ctx, wrapped, env)
	}
}

func (a *Agent) activeInputCount() int {
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	n := 0
	for _, r := range a.pluginInvocations {
		if r.Input && !r.Completed {
			n++
		}
	}
	return n
}
