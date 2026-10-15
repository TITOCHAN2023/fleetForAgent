package main

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestPluginInvocationRetryExecutesOnceAndRejectsDifferentCaller(t *testing.T) {
	a, _, _ := pageFixture(t)
	original := invokePluginTask
	defer func() { invokePluginTask = original }()
	started, release := make(chan struct{}), make(chan struct{})
	var executions atomic.Int32
	invokePluginTask = func(ctx context.Context, req pluginRequest) (any, error) {
		if executions.Add(1) == 1 {
			close(started)
		}
		select {
		case <-release:
			return map[string]any{"result": "done"}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	req := pluginRequest{Operation: "invoke", PluginID: "fleet.transfer", Action: "inspect", Input: json.RawMessage(`{}`), Local: true, Principal: "local", UIRead: true}
	var wg sync.WaitGroup
	var terminals atomic.Int32
	sink := func(_ context.Context, e Envelope) error {
		if e.Type == "plugin_result" {
			terminals.Add(1)
		}
		return nil
	}
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); a.executePlugin(context.Background(), sink, "same-corr", req) }()
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("plugin did not start")
	}
	different := req
	different.Principal = "different-caller"
	_, _, err := a.claimPluginInvocation("same-corr", different)
	if err == nil {
		t.Fatal("different principal reused execution receipt")
	}
	close(release)
	wg.Wait()
	if executions.Load() != 1 || terminals.Load() != 2 {
		t.Fatalf("execution=%d replies=%d", executions.Load(), terminals.Load())
	}
}
