package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	testPeerSessionID = "e3407bcb-732a-45ee-80e2-0f95761b5b13"
	testPeerRoundID   = "815739bb-bca5-48a9-aeee-2c16bbfe11de"
)

type fakePluginPeer struct {
	mu       sync.Mutex
	controls []any
	data     [][]byte
	read     chan pluginPeerRecord
	aborted  bool
	canceled bool
}

func newFakePluginPeer() *fakePluginPeer {
	return &fakePluginPeer{read: make(chan pluginPeerRecord, 8)}
}

func (f *fakePluginPeer) WriteControl(value any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.aborted {
		return context.Canceled
	}
	f.controls = append(f.controls, value)
	return nil
}

func (f *fakePluginPeer) WriteData(value []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.aborted {
		return context.Canceled
	}
	f.data = append(f.data, append([]byte(nil), value...))
	return nil
}

func (f *fakePluginPeer) ReadRecord() (pluginPeerRecord, error) {
	record, ok := <-f.read
	if !ok {
		return pluginPeerRecord{}, context.Canceled
	}
	return record, nil
}

func (f *fakePluginPeer) Wait() error { return nil }

func (f *fakePluginPeer) Cancel() {
	f.mu.Lock()
	f.controls = append(f.controls, map[string]any{"v": 1, "type": "cancel"})
	f.canceled = true
	f.aborted = true
	f.mu.Unlock()
}

func (f *fakePluginPeer) Abort() {
	f.mu.Lock()
	f.aborted = true
	f.mu.Unlock()
}

func (f *fakePluginPeer) status(t *testing.T, status string) {
	t.Helper()
	payload, err := json.Marshal(pluginPeerControl{V: 1, Type: "status", Status: status})
	if err != nil {
		t.Fatal(err)
	}
	f.read <- pluginPeerRecord{Kind: pluginPeerRecordJSON, Payload: payload}
}

type fakePeerDC struct {
	mu       sync.Mutex
	texts    []string
	data     [][]byte
	err      error
	buffered uint64
}

func (f *fakePeerDC) Send(value []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.data = append(f.data, append([]byte(nil), value...))
	return f.err
}
func (f *fakePeerDC) SendText(value string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.texts = append(f.texts, value)
	return f.err
}
func (f *fakePeerDC) BufferedAmount() uint64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.buffered
}
func (f *fakePeerDC) ReadyState() webrtc.DataChannelState { return webrtc.DataChannelStateOpen }

type blockingTextPeerDC struct {
	mu           sync.Mutex
	texts        []string
	firstStarted chan struct{}
	releaseFirst chan struct{}
	calls        int
}

func (f *blockingTextPeerDC) Send([]byte) error { return nil }
func (f *blockingTextPeerDC) SendText(value string) error {
	f.mu.Lock()
	f.calls++
	first := f.calls == 1
	f.mu.Unlock()
	if first {
		close(f.firstStarted)
		<-f.releaseFirst
	}
	f.mu.Lock()
	f.texts = append(f.texts, value)
	f.mu.Unlock()
	return nil
}
func (f *blockingTextPeerDC) BufferedAmount() uint64              { return 0 }
func (f *blockingTextPeerDC) ReadyState() webrtc.DataChannelState { return webrtc.DataChannelStateOpen }

func peerTestMeta() installedPlugin {
	return installedPlugin{
		ID: "example.peer", Version: "1.2.3", Runtime: pluginRuntimePeer,
		Actions: []string{"source", "target"},
		ActionSpecs: map[string]pluginActionSpec{
			"source": {Runtime: pluginRuntimePeer, Role: "source"},
			"target": {Runtime: pluginRuntimePeer, Role: "target"},
		},
		PeerProtocols: []pluginPeerProtocol{{
			ID: "example.bytes.v1", ABI: pluginPeerABI, Transport: "direct_ordered", Approval: "both_once",
			Roles: map[string]string{"source": "source", "target": "target"},
		}},
	}
}

func peerTestRequest() pluginPeerPrepareRequest {
	req := pluginPeerPrepareRequest{
		SessionID: testPeerSessionID, RoundID: testPeerRoundID, Side: "source", SignalRole: "initiator",
		Protocol:   pluginPeerProtocolRef{ID: "example.bytes.v1", ABI: pluginPeerABI, Transport: "direct_ordered", Approval: "both_once"},
		Input:      json.RawMessage(`{"value":1}`),
		OperatorID: "operator-1", UserID: "user-1",
		Peer: pluginPeerEndpoint{Kind: "tool", ID: "tool-1", PluginID: "example.peer", PluginVersion: "1.2.3", Action: "target", Role: "target"},
	}
	req.Plugin.ID = "example.peer"
	req.Plugin.Version = "1.2.3"
	req.Plugin.Action = "source"
	req.Plugin.Role = "source"
	return req
}

func peerTestPrepareBody(t *testing.T, req pluginPeerPrepareRequest) map[string]any {
	t.Helper()
	raw, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatal(err)
	}
	return body
}

func TestPluginPeerPrepareUsesRegistryIdentifiers(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*pluginPeerPrepareRequest)
	}{
		{"peer version with slash", func(req *pluginPeerPrepareRequest) { req.Peer.PluginVersion = "1/2" }},
		{"peer version with colon", func(req *pluginPeerPrepareRequest) { req.Peer.PluginVersion = "1:2" }},
		{"uppercase protocol id", func(req *pluginPeerPrepareRequest) { req.Protocol.ID = "Example.bytes.v1" }},
		{"protocol id with slash", func(req *pluginPeerPrepareRequest) { req.Protocol.ID = "example/bytes/v1" }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := peerTestRequest()
			tt.mutate(&req)
			if _, err := decodePluginPeerPrepare(peerTestPrepareBody(t, req)); err == nil {
				t.Fatal("non-registry peer identity accepted")
			}
		})
	}
}

func TestPluginPeerPrepareNormalizesSTUNContract(t *testing.T) {
	req := peerTestRequest()
	req.STUNURLs = []string{" STUN:one.example:3478 ", "StUnS:two.example:5349"}
	got, err := decodePluginPeerPrepare(peerTestPrepareBody(t, req))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"stun:one.example:3478", "stuns:two.example:5349"}
	if !slices.Equal(got.STUNURLs, want) {
		t.Fatalf("STUN URLs = %#v, want %#v", got.STUNURLs, want)
	}

	for _, urls := range [][]string{
		{"turn:relay.example:3478"},
		{"stun:bad host"},
		{"stun:"},
		{"stun:a", "stun:b", "stun:c", "stun:d", "stun:e"},
	} {
		bad := peerTestRequest()
		bad.STUNURLs = urls
		if _, err := decodePluginPeerPrepare(peerTestPrepareBody(t, bad)); err == nil {
			t.Fatalf("invalid STUN configuration accepted: %#v", urls)
		}
	}
}

func TestPluginPeerPrepareReplayIncludesSTUNConfiguration(t *testing.T) {
	req := peerTestRequest()
	req.STUNURLs = []string{"stun:one.example:3478"}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s, err := newPluginPeerSession(&Agent{}, ctx, nil, req)
	if err != nil {
		t.Fatal(err)
	}
	changed := req
	changed.STUNURLs = []string{"stun:other.example:3478"}
	if s.matchesPrepare(changed) {
		t.Fatal("same session id silently accepted changed STUN configuration")
	}
}

func TestPluginPeerRunsOpaqueFLPPPluginAndPublishesRawNoncesToWorker(t *testing.T) {
	fake := newFakePluginPeer()
	original := openPluginPeer
	originalResolve := resolveInstalledPluginPeerAction
	openPluginPeer = func(context.Context, string, string, string, string) (installedPlugin, pluginPeerIO, error) {
		return peerTestMeta(), fake, nil
	}
	resolveInstalledPluginPeerAction = func(string, string, string, string) (installedPlugin, string, error) {
		return peerTestMeta(), "/test/plugin", nil
	}
	defer func() {
		openPluginPeer = original
		resolveInstalledPluginPeerAction = originalResolve
	}()

	replies := make(chan Envelope, 8)
	agent := &Agent{enabled: true, permit: PermitAllow, deviceID: "device-1"}
	req := peerTestRequest()
	body, _ := json.Marshal(req)
	var mapped map[string]any
	_ = json.Unmarshal(body, &mapped)
	agent.handlePluginPeerPrepare(context.Background(), func(_ context.Context, env Envelope) error {
		replies <- env
		return nil
	}, Envelope{V: 1, Type: "peer_session_prepare", Body: mapped})

	agent.mu.Lock()
	pending := agent.pending
	agent.mu.Unlock()
	if pending == nil || pending.Peer == nil {
		t.Fatal("peer session bypassed local approval")
	}
	agent.approve()
	deadline := time.Now().Add(time.Second)
	for {
		fake.mu.Lock()
		count := len(fake.controls)
		fake.mu.Unlock()
		if count == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("plugin did not receive FLPP open")
		}
		time.Sleep(time.Millisecond)
	}
	fake.status(t, "ready")
	select {
	case env := <-replies:
		if env.Type != "peer_session_authorized" {
			t.Fatalf("unexpected response: %#v", env)
		}
		raw, _ := json.Marshal(env.Body)
		if !strings.Contains(string(raw), "session_binding\"") || !strings.Contains(string(raw), "round_binding\"") {
			t.Fatalf("raw nonce missing from authorize request: %s", raw)
		}
		if strings.Contains(string(raw), "session_binding_hash") || strings.Contains(string(raw), "round_binding_hash") {
			t.Fatalf("authorize request must not send client-computed hashes: %s", raw)
		}
	case <-time.After(time.Second):
		t.Fatal("plugin ready was not authorized")
	}
	agent.mu.Lock()
	session := agent.peerSessions[testPeerSessionID]
	agent.mu.Unlock()
	if session != nil {
		session.close()
	}
}

func TestPluginPeerStaleEpochCallbacksCannotMutateCurrentRound(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &pluginPeerSession{ctx: ctx, cancel: cancel, sessionID: testPeerSessionID}
	oldPlugin := newFakePluginPeer()
	newPlugin := newFakePluginPeer()
	oldCtx, oldCancel := context.WithCancel(ctx)
	newCtx, newCancel := context.WithCancel(ctx)
	defer oldCancel()
	defer newCancel()
	old := &pluginPeerEpoch{roundID: testPeerRoundID, ctx: oldCtx, cancel: oldCancel, plugin: oldPlugin}
	current := &pluginPeerEpoch{roundID: "0ef1f797-f298-4f20-8248-5284858f46ef", ctx: newCtx, cancel: newCancel, plugin: newPlugin}
	currentRound := &pluginPeerRound{epoch: current, ctx: newCtx, cancel: func() {}, dc: &fakePeerDC{}, inbox: make(chan pluginPeerIncoming, 1)}
	current.round = currentRound
	s.epoch = current

	if s.handlePluginStatus(old, oldPlugin, pluginPeerControl{V: 1, Type: "status", Status: "ready"}) {
		t.Fatal("stale plugin reader remained active")
	}
	s.dataChannelFailure(&pluginPeerRound{epoch: old, dc: &fakePeerDC{}}, &fakePeerDC{}, errors.New("late close"))
	if s.epoch != current || current.round != currentRound || current.interrupted {
		t.Fatal("stale callback polluted the current epoch")
	}
}

func TestPluginPeerStalePeerCancelCannotCloseCurrentRound(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stale := &pluginPeerEpoch{roundID: testPeerRoundID, ctx: ctx, cancel: func() {}}
	staleRound := &pluginPeerRound{epoch: stale, ctx: ctx, cancel: func() {}}
	stale.round = staleRound
	current := &pluginPeerEpoch{roundID: "0ef1f797-f298-4f20-8248-5284858f46ef", ctx: ctx, cancel: func() {}}
	currentRound := &pluginPeerRound{epoch: current, ctx: ctx, cancel: func() {}}
	current.round = currentRound
	agent := &Agent{peerSessions: make(map[string]*pluginPeerSession)}
	s := &pluginPeerSession{
		agent: agent, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, epoch: current,
		sink: func(context.Context, Envelope) error { return nil },
	}
	agent.peerSessions[testPeerSessionID] = s
	s.cancelFromPeer(staleRound, "CANCELLED")
	s.mu.Lock()
	stillCurrent := !s.closed && s.epoch == current && current.round == currentRound
	s.mu.Unlock()
	if !stillCurrent {
		t.Fatal("stale peer_cancel closed the replacement round")
	}
}

func TestPluginPeerFailureAtomicallyClaimsCurrentEpoch(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e := &pluginPeerEpoch{roundID: testPeerRoundID, ctx: ctx, cancel: func() {}}
	r := &pluginPeerRound{epoch: e, ctx: ctx, cancel: func() {}}
	e.round = r
	started := make(chan struct{})
	release := make(chan struct{})
	agent := &Agent{peerSessions: make(map[string]*pluginPeerSession)}
	s := &pluginPeerSession{
		agent: agent, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, epoch: e,
		role: "source", signalRole: "initiator", roundNo: 1,
		usedRounds: map[string]int{testPeerRoundID: 1},
		sink: func(_ context.Context, env Envelope) error {
			if env.Body["event"] == "fail" {
				close(started)
				<-release
			}
			return nil
		},
	}
	agent.peerSessions[testPeerSessionID] = s
	done := make(chan struct{})
	go func() {
		s.failEpoch(e, "PLUGIN_PROTOCOL", errors.New("bad plugin frame"))
		close(done)
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("failure event did not reach the blocking sink")
	}
	s.interruptRound(r, errors.New("concurrent transport loss"))
	if s.beginNextRound("0ef1f797-f298-4f20-8248-5284858f46ef", 2, "source", "initiator") {
		t.Fatal("replacement round started after a terminal failure had claimed the epoch")
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("terminal failure did not finish cleanup")
	}
}

func TestPluginPeerFailureCodeMatchesWorkerContract(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e := &pluginPeerEpoch{roundID: testPeerRoundID, ctx: ctx, cancel: func() {}}
	agent := &Agent{peerSessions: make(map[string]*pluginPeerSession)}
	var failureCode string
	s := &pluginPeerSession{
		agent: agent, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, epoch: e,
		sink: func(_ context.Context, env Envelope) error {
			failureCode, _ = env.Body["failure_code"].(string)
			return nil
		},
	}
	agent.peerSessions[testPeerSessionID] = s
	s.failEpoch(e, "bad-code/from-plugin", errors.New("plugin failed"))
	if failureCode != "PLUGIN_PEER_FAILED" {
		t.Fatalf("failure_code=%q does not match the Worker contract", failureCode)
	}
	if got := normalizePluginPeerFailureCode(" cancelled ", "PLUGIN_PEER_FAILED"); got != "CANCELLED" {
		t.Fatalf("normalized cancellation code = %q", got)
	}
	if got := normalizePluginPeerFailureCode(strings.Repeat("A", 65), "CANCELLED"); got != "CANCELLED" {
		t.Fatalf("oversized failure code escaped the Worker contract: %q", got)
	}
}

func TestPluginPeerTerminalStatusBeforeReadyFailsClosed(t *testing.T) {
	for _, control := range []pluginPeerControl{
		{V: 1, Type: "status", Status: "complete"},
		{V: 1, Type: "status", Status: "canceled", Code: "CANCELLED"},
		{V: 1, Type: "status", Status: "error", Code: "PLUGIN_INIT", Error: "not ready"},
	} {
		t.Run(control.Status, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			plugin := newFakePluginPeer()
			e := &pluginPeerEpoch{roundID: testPeerRoundID, ctx: ctx, cancel: cancel, plugin: plugin}
			agent := &Agent{peerSessions: make(map[string]*pluginPeerSession)}
			s := &pluginPeerSession{
				agent: agent, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, epoch: e,
				sink: func(context.Context, Envelope) error { return nil },
			}
			agent.peerSessions[testPeerSessionID] = s
			if s.handlePluginStatus(e, plugin, control) {
				t.Fatal("plugin remained active after terminal status before ready")
			}
			s.mu.Lock()
			closed := s.closed
			s.mu.Unlock()
			plugin.mu.Lock()
			aborted := plugin.aborted
			plugin.mu.Unlock()
			if !closed || !aborted {
				t.Fatalf("terminal status did not fail closed: closed=%v aborted=%v", closed, aborted)
			}
		})
	}
}

func TestPluginPeerStatementIsBoundToExactEpochAndCapabilities(t *testing.T) {
	now := time.Now().UnixMilli()
	sessionNonce, _ := newPluginPeerNonce()
	roundNonce, _ := newPluginPeerNonce()
	peerSessionNonce, _ := newPluginPeerNonce()
	peerRoundNonce, _ := newPluginPeerNonce()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &pluginPeerSession{
		ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, sessionNonce: sessionNonce,
		role: "source", signalRole: "initiator", protocol: "example.bytes.v1", pluginID: "example.peer", pluginVer: "1.2.3", action: "source",
		operatorID: "operator-1", userID: "user-1", abi: pluginPeerABI, transport: "direct_ordered", approval: "both_once",
		peer: pluginPeerEndpoint{Kind: "tool", ID: "tool-1", PluginID: "example.peer", PluginVersion: "1.2.3", Action: "target", Role: "target"},
	}
	e := &pluginPeerEpoch{roundID: testPeerRoundID, nonce: roundNonce, ctx: ctx, cancel: func() {}, ready: true}
	r := &pluginPeerRound{epoch: e, ctx: ctx, cancel: func() {}, offer: peerTestSDP("11"), answer: peerTestSDP("22")}
	e.round, s.epoch = r, e
	statement := pluginPeerStatement{
		V: 1, Kind: "plugin_peer", SessionID: testPeerSessionID, RoundID: testPeerRoundID,
		UserID: "user-1", Kid: "kid-1", OperatorID: "operator-1", Protocol: "example.bytes.v1",
		ABI: pluginPeerABI, Transport: "direct_ordered", Approval: "both_once", CapabilityDigest: strings.Repeat("a", 64),
		SourceKind: "device", SourceID: "device-1", SourcePluginID: "example.peer", SourcePluginVersion: "1.2.3", SourceAction: "source", SourceRole: "source",
		TargetKind: "tool", TargetID: "tool-1", TargetPluginID: "example.peer", TargetPluginVersion: "1.2.3", TargetAction: "target", TargetRole: "target",
		InitiatorKind: "device", InitiatorID: "device-1", ResponderKind: "tool", ResponderID: "tool-1",
		SourceSessionBindingHash: pluginPeerBindingHash(sessionNonce), SourceRoundBindingHash: pluginPeerBindingHash(roundNonce),
		TargetSessionBindingHash: pluginPeerBindingHash(peerSessionNonce), TargetRoundBindingHash: pluginPeerBindingHash(peerRoundNonce),
		OfferFP: canonicalPluginPeerFingerprint(r.offer), AnswerFP: canonicalPluginPeerFingerprint(r.answer), DirectOnly: true, Iat: now - 100, Exp: now + 1000,
	}
	statement.CapabilityDigest = pluginPeerCapabilityDigest(s)
	if _, _, err := validatePluginPeerStatement(s, e, r, statement, "kid-1", "device-1", now); err != nil {
		t.Fatal(err)
	}
	changed := statement
	changed.SourceAction = "other"
	if _, _, err := validatePluginPeerStatement(s, e, r, changed, "kid-1", "device-1", now); err == nil {
		t.Fatal("ticket with a changed action was accepted")
	}
	newEpoch := &pluginPeerEpoch{roundID: "0ef1f797-f298-4f20-8248-5284858f46ef", nonce: roundNonce, ctx: ctx, cancel: func() {}}
	s.epoch = newEpoch
	if _, _, err := validatePluginPeerStatement(s, e, r, statement, "kid-1", "device-1", now); err == nil {
		t.Fatal("old round ticket committed after epoch replacement")
	}
}

func TestPluginPeerStaleTicketIsTransportAckedWithoutAcceptance(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	currentRoundID := "0ef1f797-f298-4f20-8248-5284858f46ef"
	e := &pluginPeerEpoch{roundID: currentRoundID, ctx: ctx, cancel: cancel}
	r := &pluginPeerRound{epoch: e, ctx: ctx, cancel: func() {}}
	e.round = r
	agent := &Agent{peerSessions: make(map[string]*pluginPeerSession)}
	s := &pluginPeerSession{
		agent: agent, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, epoch: e,
		usedRounds: map[string]int{testPeerRoundID: 1, currentRoundID: 2},
	}
	agent.peerSessions[testPeerSessionID] = s
	var ack Envelope
	agent.handlePluginPeerDelivery(context.Background(), func(_ context.Context, env Envelope) error {
		ack = env
		return nil
	}, Envelope{Type: "peer_session_ticket", Body: map[string]any{
		"session_id":  testPeerSessionID,
		"round_id":    testPeerRoundID,
		"delivery_id": "ps:ticket:stale",
		"statement":   map[string]any{"payload": "not-base64", "sig": "not-base64"},
	}})
	s.mu.Lock()
	stillCurrent := !s.closed && s.epoch == e && e.round == r && !r.ticketVerified &&
		r.peerSessionHash == "" && r.peerRoundHash == ""
	s.mu.Unlock()
	if ack.Type != "peer_session_ack" || ack.Body["delivery_id"] != "ps:ticket:stale" {
		t.Fatalf("stale outbox delivery was not transport-acked: %#v", ack)
	}
	if !stillCurrent {
		t.Fatal("transport ACK for a stale ticket accepted it into the current round")
	}
}

func TestPluginPeerCurrentForgedTicketFailsClosedAndUnknownRoundIsNotAcked(t *testing.T) {
	newSession := func(t *testing.T) (*Agent, *pluginPeerSession, *[]Envelope) {
		t.Helper()
		ctx, cancel := context.WithCancel(context.Background())
		e := &pluginPeerEpoch{roundID: testPeerRoundID, ctx: ctx, cancel: cancel}
		r := &pluginPeerRound{epoch: e, ctx: ctx, cancel: func() {}}
		e.round = r
		agent := &Agent{peerSessions: make(map[string]*pluginPeerSession)}
		events := &[]Envelope{}
		s := &pluginPeerSession{
			agent: agent, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, epoch: e,
			usedRounds: map[string]int{testPeerRoundID: 1},
			sink: func(_ context.Context, env Envelope) error {
				*events = append(*events, env)
				return nil
			},
		}
		agent.peerSessions[testPeerSessionID] = s
		return agent, s, events
	}

	agent, session, events := newSession(t)
	agent.handlePluginPeerDelivery(context.Background(), session.sink, Envelope{Type: "peer_session_ticket", Body: map[string]any{
		"session_id":  testPeerSessionID,
		"round_id":    testPeerRoundID,
		"delivery_id": "ps:ticket:current-forged",
		"statement":   map[string]any{"payload": "not-base64", "sig": "not-base64"},
	}})
	session.mu.Lock()
	closed := session.closed
	session.mu.Unlock()
	if !closed || len(*events) != 2 || (*events)[0].Body["failure_code"] != "INVALID_TICKET" || (*events)[1].Type != "peer_session_ack" {
		t.Fatalf("current forged ticket did not fail closed then drain its delivery: closed=%v events=%#v", closed, *events)
	}

	agent, session, events = newSession(t)
	agent.handlePluginPeerDelivery(context.Background(), session.sink, Envelope{Type: "peer_session_ticket", Body: map[string]any{
		"session_id":  testPeerSessionID,
		"round_id":    "0ef1f797-f298-4f20-8248-5284858f46ef",
		"delivery_id": "ps:ticket:unknown",
		"statement":   map[string]any{"payload": "not-base64", "sig": "not-base64"},
	}})
	session.mu.Lock()
	closed = session.closed
	session.mu.Unlock()
	if closed || len(*events) != 0 {
		t.Fatalf("unknown round ticket was acked or mutated the current round: closed=%v events=%#v", closed, *events)
	}
	session.close()
}

func TestPluginPeerBuffersBindingsUntilItsOwnTicketIsVerified(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	peerSessionNonce, _ := newPluginPeerNonce()
	peerRoundNonce, _ := newPluginPeerNonce()
	e := &pluginPeerEpoch{roundID: testPeerRoundID, ctx: ctx, cancel: cancel}
	r := &pluginPeerRound{epoch: e, ctx: ctx, cancel: func() {}}
	e.round = r
	s := &pluginPeerSession{ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, epoch: e}
	control, err := json.Marshal(map[string]any{
		"v": 1, "type": "peer_bindings", "id": "early-bindings", "t": time.Now().UnixMilli(),
		"body": map[string]any{
			"session_id": testPeerSessionID, "round_id": testPeerRoundID,
			"session_binding": peerSessionNonce, "round_binding": peerRoundNonce,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.handlePeerControl(r, control); err != nil {
		t.Fatalf("early peer bindings were rejected: %v", err)
	}
	s.mu.Lock()
	if r.peerBindingOK || r.pendingPeerSessionBinding != peerSessionNonce {
		s.mu.Unlock()
		t.Fatal("early bindings were trusted or lost before ticket verification")
	}
	r.ticketVerified = true
	r.peerSessionHash = pluginPeerBindingHash(peerSessionNonce)
	r.peerRoundHash = pluginPeerBindingHash(peerRoundNonce)
	err = s.acceptPeerBindingsLocked(r, r.pendingPeerSessionBinding, r.pendingPeerRoundBinding)
	verified := r.peerBindingOK
	s.mu.Unlock()
	if err != nil || !verified {
		t.Fatalf("ticket did not validate buffered peer bindings: verified=%v err=%v", verified, err)
	}
}

func TestPluginPeerRoundHasOneImmutableOwner(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e := &pluginPeerEpoch{roundID: testPeerRoundID, ctx: ctx, cancel: cancel, ready: true}
	s := &pluginPeerSession{ctx: ctx, cancel: cancel, epoch: e}
	s.mu.Lock()
	r, ok := s.reserveRoundLocked(e, nil)
	if !ok {
		t.Fatal("first round was rejected")
	}
	if _, ok := s.reserveRoundLocked(e, nil); ok {
		t.Fatal("second round was accepted into the same epoch")
	}
	s.mu.Unlock()
	closePluginPeerRound(r)
}

func TestPluginPeerQueuesEarlyDataAndDrainsBeforePeerDone(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	plugin := newFakePluginPeer()
	dc := &fakePeerDC{buffered: 32}
	e := &pluginPeerEpoch{roundID: testPeerRoundID, ctx: ctx, cancel: cancel, plugin: plugin, ready: true}
	r := &pluginPeerRound{
		epoch: e, ctx: ctx, cancel: func() {}, dc: dc, open: true,
		ticketVerified: true, peerBindingOK: true, readySent: true, remoteReady: true,
		inbox: make(chan pluginPeerIncoming, 1),
	}
	e.round = r
	s := &pluginPeerSession{
		ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, epoch: e,
		sink: func(context.Context, Envelope) error { return nil },
	}
	s.sendPluginData(e, plugin, []byte("early"))
	if len(e.pendingData) != 1 {
		t.Fatal("plugin DATA emitted after ready was not queued before direct readiness")
	}
	e.localComplete = true
	s.activateRound(r)
	deadline := time.Now().Add(time.Second)
	for {
		dc.mu.Lock()
		dataCount, textCount := len(dc.data), len(dc.texts)
		dc.mu.Unlock()
		if dataCount == 1 {
			if textCount != 0 {
				t.Fatal("peer_done was sent before buffered DATA drained")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("queued DATA was not flushed")
		}
		time.Sleep(time.Millisecond)
	}
	dc.mu.Lock()
	dc.buffered = 0
	dc.mu.Unlock()
	for {
		dc.mu.Lock()
		texts := append([]string(nil), dc.texts...)
		dc.mu.Unlock()
		if len(texts) == 1 && strings.Contains(texts[0], `"type":"peer_done"`) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("peer_done was not sent after buffered DATA drained")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestPluginPeerBindingsAreDeliveredBeforeReadyUnderConcurrency(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dc := &blockingTextPeerDC{
		firstStarted: make(chan struct{}),
		releaseFirst: make(chan struct{}),
	}
	e := &pluginPeerEpoch{roundID: testPeerRoundID, nonce: "round-nonce", ctx: ctx, cancel: cancel, ready: true}
	r := &pluginPeerRound{
		epoch: e, ctx: ctx, cancel: func() {}, dc: dc, open: true,
		ticketVerified: true, peerBindingOK: true,
	}
	e.round = r
	s := &pluginPeerSession{
		ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, sessionNonce: "session-nonce", epoch: e,
	}
	bindingsDone := make(chan struct{})
	go func() {
		s.maybeSendBindings(r)
		close(bindingsDone)
	}()
	select {
	case <-dc.firstStarted:
	case <-time.After(time.Second):
		t.Fatal("bindings send did not block")
	}
	readyDone := make(chan struct{})
	go func() {
		s.maybeSendPeerReady(r)
		close(readyDone)
	}()
	close(dc.releaseFirst)
	select {
	case <-bindingsDone:
	case <-time.After(time.Second):
		t.Fatal("bindings send did not finish")
	}
	select {
	case <-readyDone:
	case <-time.After(time.Second):
		t.Fatal("ready send did not finish")
	}
	dc.mu.Lock()
	texts := append([]string(nil), dc.texts...)
	dc.mu.Unlock()
	if len(texts) != 2 || !strings.Contains(texts[0], `"type":"peer_bindings"`) ||
		!strings.Contains(texts[1], `"type":"peer_ready"`) {
		t.Fatalf("handshake controls were reordered: %q", texts)
	}
}

func TestPluginPeerActiveBeforeFirstDataIsRecoverable(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	plugin := newFakePluginPeer()
	dc := &fakePeerDC{}
	e := &pluginPeerEpoch{roundID: testPeerRoundID, ctx: ctx, cancel: cancel, plugin: plugin, ready: true}
	r := &pluginPeerRound{
		epoch: e, ctx: ctx, cancel: func() {}, dc: dc, open: true,
		ticketVerified: true, peerBindingOK: true, bindingSent: true, readySent: true, remoteReady: true,
	}
	e.round = r
	s := &pluginPeerSession{
		ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, epoch: e,
		sink: func(context.Context, Envelope) error { return nil },
	}
	s.activateRound(r)
	s.dataChannelFailure(r, dc, errors.New("lost before first DATA"))
	deadline := time.Now().Add(time.Second)
	for {
		s.mu.Lock()
		interrupted := e.interrupted && e.round == nil && !s.closed
		s.mu.Unlock()
		if interrupted {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("active round failed instead of becoming resumable before first DATA")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestPluginPeerHalfCloseTimeoutInterruptsEitherStalledSide(t *testing.T) {
	for _, localDone := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		plugin := newFakePluginPeer()
		dc := &fakePeerDC{}
		e := &pluginPeerEpoch{roundID: testPeerRoundID, ctx: ctx, cancel: cancel, plugin: plugin, ready: true}
		r := &pluginPeerRound{
			epoch: e, ctx: ctx, cancel: func() {}, dc: dc, open: true, dataOpen: true, started: true,
			localDoneSent: localDone, remoteDone: !localDone,
		}
		e.round = r
		s := &pluginPeerSession{
			ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, epoch: e,
			halfCloseWait: 20 * time.Millisecond,
			sink:          func(context.Context, Envelope) error { return nil },
		}
		s.startHalfCloseWatch(r)
		deadline := time.Now().Add(time.Second)
		for {
			s.mu.Lock()
			interrupted := e.interrupted && e.round == nil && !s.closed
			s.mu.Unlock()
			if interrupted {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("half-close timeout did not interrupt round (local_done=%v)", localDone)
			}
			time.Sleep(time.Millisecond)
		}
		cancel()
	}
}

func TestPluginPeerCancelAndInterruptHaveDifferentPluginSemantics(t *testing.T) {
	newSession := func() (*pluginPeerSession, *pluginPeerEpoch, *pluginPeerRound, *fakePluginPeer, *fakePeerDC) {
		ctx, cancel := context.WithCancel(context.Background())
		plugin := newFakePluginPeer()
		dc := &fakePeerDC{}
		e := &pluginPeerEpoch{roundID: testPeerRoundID, ctx: ctx, cancel: cancel, plugin: plugin, ready: true}
		r := &pluginPeerRound{epoch: e, ctx: ctx, cancel: func() {}, dc: dc, open: true, dataOpen: true, started: true}
		e.round = r
		agent := &Agent{peerSessions: make(map[string]*pluginPeerSession)}
		s := &pluginPeerSession{agent: agent, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, epoch: e}
		agent.peerSessions[testPeerSessionID] = s
		return s, e, r, plugin, dc
	}

	canceled, _, _, cancelPlugin, cancelDC := newSession()
	canceled.cancelFromHub()
	cancelPlugin.mu.Lock()
	wasCanceled := cancelPlugin.canceled
	cancelPlugin.mu.Unlock()
	if !wasCanceled {
		t.Fatal("explicit cancellation did not deliver FLPP cancel")
	}
	cancelDC.mu.Lock()
	peerCancel := len(cancelDC.texts) == 1 && strings.Contains(cancelDC.texts[0], `"type":"peer_cancel"`)
	cancelDC.mu.Unlock()
	if !peerCancel {
		t.Fatal("explicit cancellation was not propagated to the direct peer")
	}

	interrupted, epoch, round, interruptPlugin, interruptDC := newSession()
	interrupted.dataChannelFailure(round, interruptDC, errors.New("network lost"))
	deadline := time.Now().Add(time.Second)
	for {
		interruptPlugin.mu.Lock()
		aborted, wasCanceled := interruptPlugin.aborted, interruptPlugin.canceled
		interruptPlugin.mu.Unlock()
		if aborted {
			if wasCanceled {
				t.Fatal("network interruption sent FLPP cancel and would delete resumable state")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("interrupted plugin process was not aborted")
		}
		time.Sleep(time.Millisecond)
	}
	interrupted.mu.Lock()
	stillOpen := !interrupted.closed && interrupted.epoch == epoch && epoch.interrupted && epoch.round == nil
	interrupted.mu.Unlock()
	if !stillOpen {
		t.Fatal("interruption destroyed the session instead of waiting for a fresh round")
	}

	failed, failedEpoch, _, failedPlugin, _ := newSession()
	failed.failEpoch(failedEpoch, "INVALID_TICKET", errors.New("bad ticket"))
	failedPlugin.mu.Lock()
	failedAborted, failedCanceled := failedPlugin.aborted, failedPlugin.canceled
	failedPlugin.mu.Unlock()
	if !failedAborted || failedCanceled {
		t.Fatal("protocol failure sent explicit FLPP cancel and deleted resumable plugin state")
	}
}

func TestDroppingOnePluginPeerDoesNotClearAnotherSessionsApproval(t *testing.T) {
	agent := &Agent{peerSessions: make(map[string]*pluginPeerSession)}
	first := &pluginPeerSession{agent: agent, sessionID: "session-a"}
	second := &pluginPeerSession{agent: agent, sessionID: "session-b"}
	agent.peerSessions[first.sessionID] = first
	agent.peerSessions[second.sessionID] = second
	agent.pending = &Pending{
		Kind: pendingKindPluginPeer,
		Peer: &pluginPeerPendingApproval{session: second},
	}

	agent.dropPluginPeer(first.sessionID, first)
	if agent.pending == nil || agent.pending.Peer == nil || agent.pending.Peer.session != second {
		t.Fatal("closing session A cleared session B approval")
	}
	agent.dropPluginPeer(second.sessionID, second)
	if agent.pending != nil {
		t.Fatal("closing the pending session did not clear its own approval")
	}
}

func TestPluginPeerDeliveryDedupeDoesNotOutliveAppliedSessions(t *testing.T) {
	pendingSession := &pluginPeerSession{sessionID: "session-a"}
	agent := &Agent{
		peerSessions:      map[string]*pluginPeerSession{"session-a": pendingSession},
		peerDeliveries:    map[string]struct{}{"delivery-a": {}},
		peerDeliveryOrder: []string{"delivery-a"},
		pending: &Pending{
			Kind: pendingKindPluginPeer,
			Peer: &pluginPeerPendingApproval{session: pendingSession},
		},
	}
	sessions := agent.takePluginPeersLocked()
	if len(sessions) != 1 {
		t.Fatalf("took %d sessions, want 1", len(sessions))
	}
	if agent.peerSessions != nil || agent.peerDeliveries != nil || agent.peerDeliveryOrder != nil || agent.pending != nil {
		t.Fatal("delivery dedupe or approval survived the sessions they referred to")
	}
}

func TestPluginPeerPrepareReplayRebuildsStateAfterLostAckAndReconnect(t *testing.T) {
	originalResolve := resolveInstalledPluginPeerAction
	resolveInstalledPluginPeerAction = func(string, string, string, string) (installedPlugin, string, error) {
		return peerTestMeta(), "/test/plugin", nil
	}
	defer func() { resolveInstalledPluginPeerAction = originalResolve }()

	agent := &Agent{enabled: true, permit: PermitAllow, deviceID: "device-1"}
	req := peerTestRequest()
	body, _ := json.Marshal(req)
	var mapped map[string]any
	_ = json.Unmarshal(body, &mapped)
	mapped["delivery_id"] = "ps:prepare:replay"
	env := Envelope{V: 1, Type: "peer_session_prepare", Body: mapped}
	agent.handlePluginPeerDelivery(context.Background(), func(context.Context, Envelope) error {
		return errors.New("socket closed before ACK")
	}, env)
	agent.mu.Lock()
	first := agent.peerSessions[testPeerSessionID]
	agent.pending = nil
	sessions := agent.takePluginPeersLocked()
	agent.mu.Unlock()
	if first == nil || len(sessions) != 1 {
		t.Fatal("first prepare was not applied before the ACK was lost")
	}
	abortPluginPeers(sessions)
	acks := 0
	agent.handlePluginPeerDelivery(context.Background(), func(_ context.Context, reply Envelope) error {
		if reply.Type == "peer_session_ack" {
			acks++
		}
		return nil
	}, env)
	agent.mu.Lock()
	second := agent.peerSessions[testPeerSessionID]
	agent.mu.Unlock()
	if second == nil || second == first || acks != 1 {
		t.Fatalf("replay did not rebuild and ACK a fresh session: second=%p first=%p acks=%d", second, first, acks)
	}
	second.close()
}

func TestPluginPeerFreshRoundRestartsPluginWithImmutableEpoch(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	oldPlugin := newFakePluginPeer()
	newPlugin := newFakePluginPeer()
	oldCtx, oldCancel := context.WithCancel(ctx)
	old := &pluginPeerEpoch{roundID: testPeerRoundID, ctx: oldCtx, cancel: oldCancel, plugin: oldPlugin, interrupted: true}
	s := &pluginPeerSession{
		ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, approved: true,
		pluginID: "example.peer", pluginVer: "1.2.3", protocol: "example.bytes.v1",
		role: "source", signalRole: "initiator", action: "source", abi: pluginPeerABI, transport: "direct_ordered", approval: "both_once",
		peer: pluginPeerEndpoint{Kind: "tool", ID: "tool-1"}, epoch: old,
		roundNo: 1, usedRounds: map[string]int{testPeerRoundID: 1},
	}
	original := openPluginPeer
	openPluginPeer = func(context.Context, string, string, string, string) (installedPlugin, pluginPeerIO, error) {
		return peerTestMeta(), newPlugin, nil
	}
	defer func() { openPluginPeer = original }()
	newRound := "0ef1f797-f298-4f20-8248-5284858f46ef"
	if s.beginNextRound(newRound, 3, "source", "initiator") {
		t.Fatal("non-contiguous round number was accepted")
	}
	if !s.beginNextRound(newRound, 2, "source", "initiator") {
		t.Fatal("fresh Hub round was rejected")
	}
	if s.beginNextRound(newRound, 3, "source", "initiator") {
		t.Fatal("replayed round id with a different round number was accepted")
	}
	deadline := time.Now().Add(time.Second)
	for {
		s.mu.Lock()
		current := s.epoch
		s.mu.Unlock()
		newPlugin.mu.Lock()
		opened := len(newPlugin.controls) == 1
		newPlugin.mu.Unlock()
		if current != nil && current != old && current.roundID == newRound && current.nonce != "" && opened {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("fresh round did not restart the plugin with a new immutable epoch")
		}
		time.Sleep(time.Millisecond)
	}
	oldPlugin.mu.Lock()
	oldAborted, oldCanceled := oldPlugin.aborted, oldPlugin.canceled
	oldPlugin.mu.Unlock()
	if !oldAborted || oldCanceled {
		t.Fatal("old interrupted round was not discarded without FLPP cancel")
	}
}

func peerTestSDP(octet string) string {
	parts := make([]string, 32)
	for i := range parts {
		parts[i] = octet
	}
	return "v=0\r\na=fingerprint:sha-256 " + strings.Join(parts, ":") + "\r\n"
}

func TestPluginPeerCanonicalFixture(t *testing.T) {
	raw, err := os.ReadFile("testdata/plugin-peer-canonical.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Protocol         pluginPeerProtocolRef        `json:"protocol"`
		Source           pluginPeerCapabilityEndpoint `json:"source"`
		Target           pluginPeerCapabilityEndpoint `json:"target"`
		CapabilityDigest string                       `json:"capability_digest"`
		SDP              string                       `json:"sdp"`
		Fingerprint      string                       `json:"fingerprint"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	s := &pluginPeerSession{
		role: "source", protocol: fixture.Protocol.ID, abi: fixture.Protocol.ABI,
		transport: fixture.Protocol.Transport, approval: fixture.Protocol.Approval,
		pluginID: fixture.Source.PluginID, pluginVer: fixture.Source.PluginVersion,
		action: fixture.Source.Action,
		peer: pluginPeerEndpoint{
			PluginID: fixture.Target.PluginID, PluginVersion: fixture.Target.PluginVersion,
			Action: fixture.Target.Action, Role: fixture.Target.Role,
		},
	}
	if got := pluginPeerCapabilityDigest(s); got != fixture.CapabilityDigest {
		t.Fatalf("capability digest=%s want=%s", got, fixture.CapabilityDigest)
	}
	if got := canonicalPluginPeerFingerprint(fixture.SDP); got != fixture.Fingerprint {
		t.Fatalf("fingerprint=%s want=%s", got, fixture.Fingerprint)
	}
}
