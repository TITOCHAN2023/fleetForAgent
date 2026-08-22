package main

import (
	"context"
	"fmt"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const (
	defaultHeartbeat = 25 * time.Second
	minHeartbeat     = 5 * time.Second
	maxHeartbeat     = 120 * time.Second
	pingWait         = 10 * time.Second
)

func heartbeatEvery(body map[string]any) time.Duration {
	d := defaultHeartbeat
	switch n := body["heartbeat_s"].(type) {
	case float64:
		if n > 0 {
			d = time.Duration(n * float64(time.Second))
		}
	case int:
		if n > 0 {
			d = time.Duration(n) * time.Second
		}
	case int64:
		if n > 0 {
			d = time.Duration(n) * time.Second
		}
	}
	if d < minHeartbeat {
		return minHeartbeat
	}
	if d > maxHeartbeat {
		return maxHeartbeat
	}
	return d
}

// heartbeatLoop keeps the hub's online bit honest. hello_ok advertises
// heartbeat_s but older agents never sent anything, so a half-open TCP
// (common on Windows after sleep / NAT idle) left list_computers offline
// while the tray still said connected.
func (a *Agent) heartbeatLoop(ctx context.Context, c *websocket.Conn) {
	a.beat(ctx, c)
	for {
		a.mu.Lock()
		d := a.hb
		a.mu.Unlock()
		if d <= 0 {
			d = defaultHeartbeat
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(d):
		}
		if !a.beat(ctx, c) {
			return
		}
	}
}

func (a *Agent) beat(ctx context.Context, c *websocket.Conn) bool {
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
	env := Envelope{
		V:    1,
		Type: "ping",
		ID:   fmt.Sprintf("%d", time.Now().UnixNano()),
		T:    time.Now().UnixMilli(),
		Body: map[string]any{},
	}
	if err := wsjson.Write(ctx, c, env); err != nil {
		a.log("warn", "heartbeat send: "+err.Error())
		_ = c.Close(websocket.StatusGoingAway, "heartbeat send")
		return false
	}
	return true
}
