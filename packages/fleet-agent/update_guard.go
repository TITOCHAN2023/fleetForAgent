package main

import "context"

// Work admission and the final automatic-update decision share a.mu. A task
// either owns a reservation before promotion, or is refused without executing.
func (a *Agent) beginWork() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.updateCommitting || a.restarting {
		return false
	}
	a.activeWork++
	return true
}

func (a *Agent) finishWork() {
	a.mu.Lock()
	a.activeWork--
	a.mu.Unlock()
}

// goWork transfers already admitted work to a goroutine. Reserve before the
// caller can release its reservation (or clear pending consent), not inside go.
func (a *Agent) goWork(work func()) {
	a.mu.Lock()
	a.activeWork++
	a.mu.Unlock()
	go func() {
		defer a.finishWork()
		work()
	}()
}

func (a *Agent) beginAutoUpdateCommit() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.autoUpdate || !a.enabled || a.authRevoked || !a.isIdleLocked() {
		return false
	}
	a.updateCommitting = true
	return true
}

func (a *Agent) endAutoUpdateCommit() {
	a.mu.Lock()
	a.updateCommitting = false
	a.mu.Unlock()
}

func updateGuardedEnvelope(kind string) bool {
	switch kind {
	case "run", "type", "plugin", "desktop_screenshot", "desktop_action":
		return true
	}
	return false
}

func (a *Agent) replyUpdateBusy(ctx context.Context, sink EnvelopeSink, env Envelope) {
	if _, recoverable := env.Body["request_id"].(string); env.Type == "run" && recoverable {
		fp := envelopeFingerprint(env.Body)
		key, path := a.operationKey(env.Corr, fp)
		a.operationMu.Lock()
		row := a.operations[key]
		var err error
		if row == nil {
			row, err = readOperation(path)
		}
		if row != nil {
			copy := *row
			row = &copy
		}
		a.operationMu.Unlock()
		if err != nil {
			_ = sink(ctx, operationEnv(env.Corr, nil))
			return
		}
		if row != nil {
			// A duplicate is a query, not new work. Never replace evidence of
			// prior execution with a misleading "not started" upgrade refusal.
			cmd, _ := env.Body["command"].(string)
			a.replyStoredRun(ctx, sink, env.Corr, cmd, fp, row)
			return
		}
	}
	const msg = "fleet: automatic update is committing; request not started"
	reply := resultEnv(env.Corr, false, 126, "", msg)
	switch env.Type {
	case "plugin":
		reply.Type = "plugin_result"
		reply.Body["status"] = "done"
	case "type":
		reply = typedEnv(env.Corr, false, msg)
	case "desktop_screenshot", "desktop_action":
		reply.Type = "desktop"
		reply.Body["status"] = "error"
		reply.Body["code"] = "busy"
	}
	_ = sink(ctx, reply)
}
