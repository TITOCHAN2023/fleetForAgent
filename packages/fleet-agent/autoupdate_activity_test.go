package main

import (
	"context"
	"testing"
	"time"

	"github.com/TITOCHAN2023/fleetForAgent/internal/pane"
)

// Uses only the pre-fix API so this regression can also run on the release
// baseline. A plugin is real work even when no shell pane exists.
func TestAutoUpdatePluginIsNotIdle(t *testing.T) {
	installPluginTestBinary(t)
	original := invokePluginTask
	started, finish, result := make(chan struct{}), make(chan struct{}), make(chan struct{})
	invokePluginTask = func(context.Context, pluginRequest) (any, error) {
		close(started)
		<-finish
		return "done", nil
	}
	defer func() {
		close(finish)
		select {
		case <-result:
		case <-time.After(3 * time.Second):
			t.Error("plugin did not finish")
		}
		invokePluginTask = original
	}()
	a := &Agent{autoUpdate: true, enabled: true, permit: PermitAllow, panes: pane.NewSupervisor()}
	a.dispatchEnvelope(context.Background(), func(_ context.Context, env Envelope) error {
		if env.Type == "plugin_result" {
			close(result)
		}
		return nil
	}, pluginInvokeEnvelope())
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("plugin not started")
	}
	a.mu.Lock()
	idle := a.isIdleLocked()
	a.mu.Unlock()
	if idle {
		t.Fatal("running plugin incorrectly classified as idle")
	}
}
