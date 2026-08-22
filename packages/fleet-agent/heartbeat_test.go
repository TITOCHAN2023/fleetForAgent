package main

import (
	"testing"
	"time"
)

func TestHeartbeatEveryDefault(t *testing.T) {
	if got := heartbeatEvery(nil); got != 25*time.Second {
		t.Fatalf("nil body: %s", got)
	}
	if got := heartbeatEvery(map[string]any{}); got != 25*time.Second {
		t.Fatalf("empty: %s", got)
	}
}

func TestHeartbeatEveryFromHelloOk(t *testing.T) {
	if got := heartbeatEvery(map[string]any{"heartbeat_s": float64(25)}); got != 25*time.Second {
		t.Fatalf("float 25: %s", got)
	}
	if got := heartbeatEvery(map[string]any{"heartbeat_s": 10}); got != 10*time.Second {
		t.Fatalf("int 10: %s", got)
	}
}

func TestHeartbeatEveryClamps(t *testing.T) {
	if got := heartbeatEvery(map[string]any{"heartbeat_s": float64(1)}); got != 5*time.Second {
		t.Fatalf("want min 5s, got %s", got)
	}
	if got := heartbeatEvery(map[string]any{"heartbeat_s": float64(999)}); got != 120*time.Second {
		t.Fatalf("want max 120s, got %s", got)
	}
}
