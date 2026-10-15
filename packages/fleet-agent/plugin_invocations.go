package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"
)

// A transport retry may attach another sink but must never run a command twice.
// Receipts are bounded to one hour, matching the existing task deadline.
type pluginInvocationReceipt struct {
	Digest    string
	Done      chan struct{}
	Envelope  Envelope
	Expires   time.Time
	Completed bool
	Retryable bool
	Input     bool
}

func (a *Agent) claimPluginInvocation(corr string, req pluginRequest) (*pluginInvocationReceipt, bool, error) {
	b, err := json.Marshal(struct {
		Request   pluginRequest
		Principal string
		Local     bool
	}{req, req.Principal, req.Local})
	if err != nil {
		return nil, false, err
	}
	sum := sha256.Sum256(b)
	digest := hex.EncodeToString(sum[:])
	interrupted := pluginResultEnv(corr, nil, errors.New("previous execution outcome unknown after restart; inspect device activity before starting a new task"))
	interrupted.Body["code"] = "EXECUTION_INTERRUPTED"
	return a.claimInvocation(corr, digest, interrupted)
}

func (a *Agent) claimInvocation(corr, digest string, interrupted Envelope) (*pluginInvocationReceipt, bool, error) {
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	if a.pluginInvocations == nil {
		a.pluginInvocations = map[string]*pluginInvocationReceipt{}
	}
	if receipt := a.pluginInvocations[corr]; receipt != nil && (!receipt.Completed || !time.Now().After(receipt.Expires)) {
		if receipt.Digest != digest {
			return nil, false, errors.New("correlation reused with different input or caller")
		}
		if !receipt.Retryable {
			return receipt, false, nil
		}
		delete(a.pluginInvocations, corr)
	}
	for id, r := range a.pluginInvocations {
		if r.Completed && time.Now().After(r.Expires) {
			delete(a.pluginInvocations, id)
		}
	}
	if len(a.pluginInvocations) >= 512 {
		return nil, false, errors.New("plugin invocation capacity reached")
	}
	expires := time.Now().Add(time.Hour)
	var replay Envelope
	if a.invocationReceipts != nil {
		claim, err := a.invocationReceipts.Claim(corr, digest, expires)
		if err != nil {
			return nil, false, err
		}
		if claim.Interrupted {
			replay = interrupted
		}
		if len(claim.Reply) > 0 {
			if json.Unmarshal(claim.Reply, &replay) != nil {
				return nil, false, errors.New("invalid stored execution reply")
			}
		}
		if !claim.Execute {
			receipt := &pluginInvocationReceipt{Digest: digest, Done: make(chan struct{}), Envelope: replay, Completed: true, Expires: expires}
			close(receipt.Done)
			a.pluginInvocations[corr] = receipt
			return receipt, false, nil
		}
	}
	receipt := &pluginInvocationReceipt{Digest: digest, Done: make(chan struct{}), Expires: time.Now().Add(time.Hour)}
	a.pluginInvocations[corr] = receipt
	return receipt, true, nil
}
func (a *Agent) completePluginInvocation(corr string, env Envelope) Envelope {
	return a.finishInvocation(corr, env, false)
}
func (a *Agent) finishInvocation(corr string, env Envelope, retryable bool) Envelope {
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	receipt := a.pluginInvocations[corr]
	if receipt == nil || receipt.Completed {
		return env
	}
	if a.invocationReceipts != nil {
		b, err := json.Marshal(env)
		if err == nil {
			if retryable {
				err = a.invocationReceipts.Defer(corr, b)
			} else {
				err = a.invocationReceipts.Complete(corr, b)
			}
		}
		if err != nil {
			body := make(map[string]any, len(env.Body)+4)
			for k, v := range env.Body {
				body[k] = v
			}
			body["ok"], body["status"], body["code"] = false, "error", "RECEIPT_WRITE_FAILED"
			body["error"] = "execution completed but its receipt could not be durably saved; do not rerun this correlation"
			body["exit_code"], body["stderr"], body["stdout"] = 1, "execution receipt write failed", ""
			env.Body = body
			retryable = false
		}
	}
	receipt.Envelope = env
	receipt.Completed = true
	receipt.Retryable = retryable
	close(receipt.Done)
	return env
}
