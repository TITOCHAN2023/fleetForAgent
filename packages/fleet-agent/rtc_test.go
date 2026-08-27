package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/TITOCHAN2023/fleetForAgent/internal/pane"
	"github.com/pion/webrtc/v4"
)

func TestRTCDataChannelUsesSharedEnvelopeDispatch(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	agent := &Agent{
		enabled: true, permit: PermitAllow, panes: pane.NewSupervisor(),
		policyBlocked: func(command string) bool { return command == "printf must-not-run" },
		relaySink:     func(_ context.Context, _ Envelope) error { return nil },
	}
	operator, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer operator.Close()
	dc, err := operator.CreateDataChannel("fleet-v1", nil)
	if err != nil {
		t.Fatal(err)
	}
	replies := make(chan Envelope, 16)
	opened := make(chan struct{})
	dc.OnOpen(func() { close(opened) })
	dc.OnMessage(func(message webrtc.DataChannelMessage) {
		var env Envelope
		if json.Unmarshal(message.Data, &env) == nil {
			replies <- env
		}
	})

	offer, err := operator.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(operator)
	if err := operator.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	local := operator.LocalDescription()
	if local == nil {
		t.Fatal("missing offer")
	}
	session, answer, err := agent.newRTCSession(ctx, "test-session", "test-operator", local.SDP, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.close()
	session.mu.Lock()
	session.authorized = true
	session.mu.Unlock()
	if err := operator.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-opened:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	waitRTCReply(t, ctx, replies, "", func(env Envelope) bool {
		return env.Type == "rtc_ready" && env.Body["sid"] == "test-session"
	})

	send := func(env Envelope) {
		b, err := json.Marshal(env)
		if err != nil {
			t.Fatal(err)
		}
		if err := dc.SendText(string(b)); err != nil {
			t.Fatal(err)
		}
	}
	send(Envelope{V: 1, Type: "run", ID: "one", Corr: "rtc-ok", T: time.Now().UnixMilli(), Body: map[string]any{
		"command": "printf rtc-ok", "fingerprint": "test-operator",
	}})
	waitRTCReply(t, ctx, replies, "rtc-ok", func(env Envelope) bool {
		return env.Type == "result" && env.Body["ok"] == true && strings.Contains(env.Body["stdout"].(string), "rtc-ok")
	})

	send(Envelope{V: 1, Type: "run", ID: "two", Corr: "rtc-blocked", T: time.Now().UnixMilli(), Body: map[string]any{
		"command": "printf must-not-run", "fingerprint": "test-operator",
	}})
	waitRTCReply(t, ctx, replies, "rtc-blocked", func(env Envelope) bool {
		return env.Type == "result" && env.Body["ok"] == false && env.Body["exit_code"] == float64(126)
	})
}

func TestRTCClaimIsOnceAndResponseFallsBackToRelay(t *testing.T) {
	var got []Envelope
	agent := &Agent{relaySink: func(_ context.Context, env Envelope) error {
		got = append(got, env)
		return nil
	}}
	session := &rtcAgentSession{
		sid: "11111111-2222-4333-8444-555555555555", operatorID: "operator-1", authorized: true,
	}
	if !agent.claimRTCEnvelope(context.Background(), session, "corr-1") ||
		!agent.claimRTCEnvelope(context.Background(), session, "corr-1") {
		t.Fatal("claim should use the relay and stay idempotent")
	}
	if len(got) != 1 || got[0].Type != "rtc_claim" || got[0].Corr != "corr-1" {
		t.Fatalf("claim envelopes=%+v", got)
	}
	if err := agent.rtcSink(session)(context.Background(), resultEnv("corr-1", true, 0, "ok", "")); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[1].Type != "result" || got[1].Corr != "corr-1" {
		t.Fatalf("fallback envelopes=%+v", got)
	}
}

func waitRTCReply(t *testing.T, ctx context.Context, replies <-chan Envelope, corr string, accept func(Envelope) bool) {
	t.Helper()
	for {
		select {
		case env := <-replies:
			if env.Corr == corr && accept(env) {
				return
			}
		case <-ctx.Done():
			t.Fatalf("timeout waiting for %s", corr)
		}
	}
}
