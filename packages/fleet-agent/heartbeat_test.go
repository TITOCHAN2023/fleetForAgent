package main

import (
	"testing"
	"time"
)

func TestNextHeartbeatAtNextClockHour(t *testing.T) {
	after := time.Date(2026, 8, 22, 5, 20, 0, 0, time.UTC)
	start := time.Date(2026, 8, 22, 6, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	seen := map[int]bool{}
	for i := 0; i < 80; i++ {
		next := nextHeartbeatAt(after)
		if next.Before(start) || !next.Before(end) {
			t.Fatalf("after %s got %s, want [%s, %s)", after, next, start, end)
		}
		seen[next.Minute()] = true
	}
	if len(seen) < 8 {
		t.Fatalf("expected jitter across the hour, got %d distinct minutes", len(seen))
	}
}

func TestPresenceEnvelopeIncludesAgentVer(t *testing.T) {
	env := presenceEnvelope()
	if env.V != 1 || env.Type != "ping" {
		t.Fatalf("presence envelope %+v", env)
	}
	got, _ := env.Body["agent_ver"].(string)
	if got != agentVersion || got == "" {
		t.Fatalf("agent_ver=%q want %q", got, agentVersion)
	}
}

func TestNextHeartbeatAtOnTheHour(t *testing.T) {
	after := time.Date(2026, 8, 22, 6, 0, 0, 0, time.UTC)
	start := time.Date(2026, 8, 22, 7, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	next := nextHeartbeatAt(after)
	if next.Before(start) || !next.Before(end) {
		t.Fatalf("after %s got %s, want [%s, %s)", after, next, start, end)
	}
}
