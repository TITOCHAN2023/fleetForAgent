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

func TestNextHeartbeatAtOnTheHour(t *testing.T) {
	after := time.Date(2026, 8, 22, 6, 0, 0, 0, time.UTC)
	start := time.Date(2026, 8, 22, 7, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	next := nextHeartbeatAt(after)
	if next.Before(start) || !next.Before(end) {
		t.Fatalf("after %s got %s, want [%s, %s)", after, next, start, end)
	}
}
