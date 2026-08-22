package main

import (
	"context"
	"fmt"
	"math/rand"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const (
	livenessEvery = 25 * time.Second
	pingWait      = 10 * time.Second
)

// nextHeartbeatAt picks a random instant in the next clock hour after after.
// A report at 5:20 schedules the next one somewhere in [6:00, 7:00).
func nextHeartbeatAt(after time.Time) time.Time {
	start := after.Truncate(time.Hour).Add(time.Hour)
	return start.Add(time.Duration(rand.Int63n(int64(time.Hour))))
}

// heartbeatLoop reports presence once on connect, then once per following
// clock hour at a client-chosen random time so devices do not stampede the hub.
// A cheap websocket Ping still runs often enough to notice half-open TCP.
func (a *Agent) heartbeatLoop(ctx context.Context, c *websocket.Conn) {
	go a.livenessLoop(ctx, c)
	if !a.reportBeat(ctx, c) {
		return
	}
	for {
		next := nextHeartbeatAt(time.Now())
		wait := time.Until(next)
		if wait < 0 {
			wait = 0
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if !a.reportBeat(ctx, c) {
			return
		}
	}
}

func (a *Agent) livenessLoop(ctx context.Context, c *websocket.Conn) {
	t := time.NewTicker(livenessEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if !a.livenessPing(ctx, c) {
				return
			}
		}
	}
}

func (a *Agent) livenessPing(ctx context.Context, c *websocket.Conn) bool {
	a.mu.Lock()
	live := a.ws == c
	a.mu.Unlock()
	if !live {
		return false
	}
	pingCtx, cancel := context.WithTimeout(ctx, pingWait)
	err := c.Ping(pingCtx)
	cancel()
	if err != nil {
		a.log("warn", "heartbeat ping: "+err.Error())
		_ = c.Close(websocket.StatusGoingAway, "heartbeat timeout")
		return false
	}
	return true
}

func presenceEnvelope() Envelope {
	return Envelope{
		V:    1,
		Type: "ping",
		ID:   fmt.Sprintf("%d", time.Now().UnixNano()),
		T:    time.Now().UnixMilli(),
		Body: map[string]any{"agent_ver": agentVersion},
	}
}

func (a *Agent) sendPresence(ctx context.Context, c *websocket.Conn) bool {
	if err := wsjson.Write(ctx, c, presenceEnvelope()); err != nil {
		a.log("warn", "heartbeat send: "+err.Error())
		_ = c.Close(websocket.StatusGoingAway, "heartbeat send")
		return false
	}
	return true
}

func (a *Agent) reportBeat(ctx context.Context, c *websocket.Conn) bool {
	if !a.livenessPing(ctx, c) {
		return false
	}
	return a.sendPresence(ctx, c)
}
