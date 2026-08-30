package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
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

type pluginPeerStopCall struct {
	kind string
	err  error
}

type contextWatchingPluginPeer struct {
	ctx   context.Context
	first chan pluginPeerStopCall
	once  sync.Once
}

func newContextWatchingPluginPeer(ctx context.Context) *contextWatchingPluginPeer {
	p := &contextWatchingPluginPeer{ctx: ctx, first: make(chan pluginPeerStopCall, 1)}
	go func() {
		<-ctx.Done()
		p.record("abort")
	}()
	return p
}

func (p *contextWatchingPluginPeer) record(kind string) {
	p.once.Do(func() { p.first <- pluginPeerStopCall{kind: kind, err: p.ctx.Err()} })
}

func (p *contextWatchingPluginPeer) WriteControl(any) error { return nil }
func (p *contextWatchingPluginPeer) WriteData([]byte) error { return nil }
func (p *contextWatchingPluginPeer) ReadRecord() (pluginPeerRecord, error) {
	return pluginPeerRecord{}, context.Canceled
}
func (p *contextWatchingPluginPeer) Wait() error { return nil }
func (p *contextWatchingPluginPeer) Cancel() bool {
	p.record("cancel")
	return true
}
func (p *contextWatchingPluginPeer) Abort() { p.record("abort") }

type blockingCancelPluginPeer struct {
	started chan<- struct{}
	release <-chan struct{}
	cancels atomic.Int32
	aborts  atomic.Int32
}

func (p *blockingCancelPluginPeer) WriteControl(any) error { return nil }
func (p *blockingCancelPluginPeer) WriteData([]byte) error { return nil }
func (p *blockingCancelPluginPeer) ReadRecord() (pluginPeerRecord, error) {
	return pluginPeerRecord{}, context.Canceled
}
func (p *blockingCancelPluginPeer) Wait() error { return nil }
func (p *blockingCancelPluginPeer) Cancel() bool {
	p.cancels.Add(1)
	p.started <- struct{}{}
	<-p.release
	return true
}
func (p *blockingCancelPluginPeer) Abort() { p.aborts.Add(1) }

type blockingAbortPluginPeer struct {
	started chan<- struct{}
	release <-chan struct{}
	cancels atomic.Int32
	aborts  atomic.Int32
}

func (p *blockingAbortPluginPeer) WriteControl(any) error { return nil }
func (p *blockingAbortPluginPeer) WriteData([]byte) error { return nil }
func (p *blockingAbortPluginPeer) ReadRecord() (pluginPeerRecord, error) {
	return pluginPeerRecord{}, context.Canceled
}
func (p *blockingAbortPluginPeer) Wait() error { return nil }
func (p *blockingAbortPluginPeer) Cancel() bool {
	p.cancels.Add(1)
	return true
}
func (p *blockingAbortPluginPeer) Abort() {
	p.aborts.Add(1)
	p.started <- struct{}{}
	<-p.release
}

type blockingOpenControlPluginPeer struct {
	*fakePluginPeer
	started chan struct{}
	release <-chan struct{}
	once    sync.Once
}

type lateSuccessfulOpenPluginPeer struct {
	*fakePluginPeer
	started chan struct{}
	release <-chan struct{}
	once    sync.Once
}

type failingCancelPluginPeer struct {
	*fakePluginPeer
	started chan struct{}
	release <-chan struct{}
	once    sync.Once
	cancels atomic.Int32
}

func (p *failingCancelPluginPeer) WriteControl(value any) error {
	if p.started != nil {
		p.once.Do(func() { close(p.started) })
		<-p.release
	}
	return p.fakePluginPeer.WriteControl(value)
}

func (p *failingCancelPluginPeer) Cancel() bool {
	p.cancels.Add(1)
	return false
}

func (p *blockingOpenControlPluginPeer) WriteControl(value any) error {
	p.once.Do(func() { close(p.started) })
	<-p.release
	return p.fakePluginPeer.WriteControl(value)
}

func (p *lateSuccessfulOpenPluginPeer) WriteControl(value any) error {
	p.once.Do(func() { close(p.started) })
	<-p.release
	p.mu.Lock()
	p.controls = append(p.controls, value)
	p.mu.Unlock()
	return nil
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

func (f *fakePluginPeer) Cancel() bool {
	f.mu.Lock()
	f.controls = append(f.controls, map[string]any{"v": 1, "type": "cancel"})
	f.canceled = true
	f.aborted = true
	f.mu.Unlock()
	return true
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
	if pending != nil {
		t.Fatalf("permit=allow created local approval: %#v", pending)
	}
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

func TestPluginPeerPrepareFollowsOffAndAsk(t *testing.T) {
	originalOpen := openPluginPeer
	originalResolve := resolveInstalledPluginPeerAction
	defer func() {
		openPluginPeer = originalOpen
		resolveInstalledPluginPeerAction = originalResolve
	}()
	resolveInstalledPluginPeerAction = func(string, string, string, string) (installedPlugin, string, error) {
		return peerTestMeta(), "/test/plugin", nil
	}

	t.Run("off", func(t *testing.T) {
		resolved := false
		resolveInstalledPluginPeerAction = func(string, string, string, string) (installedPlugin, string, error) {
			resolved = true
			return peerTestMeta(), "/test/plugin", nil
		}
		opened := make(chan struct{}, 1)
		openPluginPeer = func(context.Context, string, string, string, string) (installedPlugin, pluginPeerIO, error) {
			opened <- struct{}{}
			return peerTestMeta(), newFakePluginPeer(), nil
		}
		replies := make(chan Envelope, 1)
		agent := &Agent{enabled: true, permit: PermitOff, deviceID: "device-1"}
		req := peerTestRequest()
		body, _ := json.Marshal(req)
		var mapped map[string]any
		_ = json.Unmarshal(body, &mapped)
		if agent.handlePluginPeerPrepare(context.Background(), func(_ context.Context, env Envelope) error {
			replies <- env
			return nil
		}, Envelope{V: 1, Type: "peer_session_prepare", Body: mapped}) {
			t.Fatal("permit=off accepted peer prepare")
		}
		env := <-replies
		if env.Type != "peer_session_event" || env.Body["event"] != "fail" || env.Body["failure_code"] != "DEVICE_DISABLED" {
			t.Fatalf("off response=%#v", env)
		}
		agent.mu.Lock()
		pending, sessions := agent.pending, len(agent.peerSessions)
		agent.mu.Unlock()
		if pending != nil || sessions != 0 {
			t.Fatalf("off retained pending=%#v sessions=%d", pending, sessions)
		}
		select {
		case <-opened:
			t.Fatal("permit=off opened peer plugin")
		default:
		}
		if resolved {
			t.Fatal("permit=off hashed the installed peer plugin before rejecting")
		}
	})

	t.Run("ask", func(t *testing.T) {
		resolveInstalledPluginPeerAction = func(string, string, string, string) (installedPlugin, string, error) {
			return peerTestMeta(), "/test/plugin", nil
		}
		fake := newFakePluginPeer()
		opened := make(chan struct{}, 1)
		openPluginPeer = func(context.Context, string, string, string, string) (installedPlugin, pluginPeerIO, error) {
			opened <- struct{}{}
			return peerTestMeta(), fake, nil
		}
		agent := &Agent{enabled: true, permit: PermitAsk, deviceID: "device-1"}
		req := peerTestRequest()
		body, _ := json.Marshal(req)
		var mapped map[string]any
		_ = json.Unmarshal(body, &mapped)
		if !agent.handlePluginPeerPrepare(context.Background(), func(context.Context, Envelope) error { return nil }, Envelope{V: 1, Type: "peer_session_prepare", Body: mapped}) {
			t.Fatal("permit=ask rejected peer prepare")
		}
		agent.mu.Lock()
		pending := agent.pending
		agent.mu.Unlock()
		if pending == nil || pending.Kind != pendingKindPluginPeer || pending.Peer == nil {
			t.Fatalf("ask pending=%#v", pending)
		}
		select {
		case <-opened:
			t.Fatal("permit=ask opened peer plugin before approval")
		default:
		}
		agent.approve()
		select {
		case <-opened:
		case <-time.After(time.Second):
			t.Fatal("approved peer plugin did not open")
		}
		agent.mu.Lock()
		session := agent.peerSessions[testPeerSessionID]
		agent.mu.Unlock()
		if session != nil {
			session.close()
		}
	})
}

func TestPluginPeerAllowIgnoresStaleAskPending(t *testing.T) {
	originalOpen := openPluginPeer
	originalResolve := resolveInstalledPluginPeerAction
	defer func() {
		openPluginPeer = originalOpen
		resolveInstalledPluginPeerAction = originalResolve
	}()
	fake := newFakePluginPeer()
	opened := make(chan struct{}, 1)
	openPluginPeer = func(context.Context, string, string, string, string) (installedPlugin, pluginPeerIO, error) {
		opened <- struct{}{}
		return peerTestMeta(), fake, nil
	}
	resolveInstalledPluginPeerAction = func(string, string, string, string) (installedPlugin, string, error) {
		return peerTestMeta(), "/test/plugin", nil
	}
	stale := &Pending{Kind: pendingKindRun, Corr: "old", Command: "old command"}
	agent := &Agent{enabled: true, permit: PermitAllow, pending: stale, deviceID: "device-1"}
	req := peerTestRequest()
	if !agent.handlePluginPeerPrepare(context.Background(), func(context.Context, Envelope) error { return nil }, Envelope{
		V: 1, Type: "peer_session_prepare", Body: peerTestPrepareBody(t, req),
	}) {
		t.Fatal("permit=allow rejected peer prepare because an old ask pending remained")
	}
	select {
	case <-opened:
	case <-time.After(time.Second):
		t.Fatal("permit=allow did not start peer plugin")
	}
	agent.mu.Lock()
	pending := agent.pending
	session := agent.peerSessions[testPeerSessionID]
	agent.mu.Unlock()
	if pending != stale {
		t.Fatalf("peer prepare replaced unrelated pending=%#v", pending)
	}
	if session != nil {
		session.close()
	}
}

func TestPluginPeerSessionHoldsPluginReadLockUntilClose(t *testing.T) {
	originalOpen := openPluginPeer
	originalResolve := resolveInstalledPluginPeerAction
	defer func() {
		openPluginPeer = originalOpen
		resolveInstalledPluginPeerAction = originalResolve
	}()
	fake := newFakePluginPeer()
	opened := make(chan struct{}, 1)
	openPluginPeer = func(context.Context, string, string, string, string) (installedPlugin, pluginPeerIO, error) {
		opened <- struct{}{}
		return peerTestMeta(), fake, nil
	}
	resolveInstalledPluginPeerAction = func(string, string, string, string) (installedPlugin, string, error) {
		return peerTestMeta(), "/test/plugin", nil
	}
	agent := &Agent{enabled: true, permit: PermitAllow, deviceID: "device-1"}
	if !agent.handlePluginPeerPrepare(context.Background(), func(context.Context, Envelope) error { return nil }, Envelope{
		V: 1, Type: "peer_session_prepare", Body: peerTestPrepareBody(t, peerTestRequest()),
	}) {
		t.Fatal("peer prepare rejected")
	}
	select {
	case <-opened:
	case <-time.After(time.Second):
		t.Fatal("peer plugin did not open")
	}
	writerEntered := make(chan struct{})
	writerDone := make(chan struct{})
	go func() {
		_, _ = withPluginWriteLock("example.peer", func() (any, error) {
			close(writerEntered)
			return nil, nil
		})
		close(writerDone)
	}()
	select {
	case <-writerEntered:
		t.Fatal("plugin writer crossed a live peer session")
	case <-time.After(50 * time.Millisecond):
	}
	agent.mu.Lock()
	session := agent.peerSessions[testPeerSessionID]
	agent.mu.Unlock()
	if session == nil {
		t.Fatal("peer session disappeared before close")
	}
	session.close()
	select {
	case <-writerEntered:
	case <-time.After(time.Second):
		t.Fatal("peer close did not release plugin read lock")
	}
	select {
	case <-writerDone:
	case <-time.After(time.Second):
		t.Fatal("plugin writer did not finish")
	}
}

func TestPluginPeerStartKeepsReadLockWhenPermitTurnsOff(t *testing.T) {
	originalOpen := openPluginPeer
	originalResolve := resolveInstalledPluginPeerAction
	defer func() {
		openPluginPeer = originalOpen
		resolveInstalledPluginPeerAction = originalResolve
	}()
	openStarted := make(chan struct{})
	releaseOpen := make(chan struct{})
	openPluginPeer = func(context.Context, string, string, string, string) (installedPlugin, pluginPeerIO, error) {
		close(openStarted)
		<-releaseOpen
		return peerTestMeta(), newFakePluginPeer(), nil
	}
	resolveInstalledPluginPeerAction = func(string, string, string, string) (installedPlugin, string, error) {
		return peerTestMeta(), "/test/plugin", nil
	}
	agent := &Agent{enabled: true, permit: PermitAllow, deviceID: "device-1", cfgPath: t.TempDir() + "/config.json"}
	if !agent.handlePluginPeerPrepare(context.Background(), func(context.Context, Envelope) error { return nil }, Envelope{
		V: 1, Type: "peer_session_prepare", Body: peerTestPrepareBody(t, peerTestRequest()),
	}) {
		t.Fatal("peer prepare rejected")
	}
	select {
	case <-openStarted:
	case <-time.After(time.Second):
		t.Fatal("peer plugin open did not start")
	}
	offDone := make(chan struct{})
	go func() {
		agent.setPermit(PermitOff)
		close(offDone)
	}()
	select {
	case <-offDone:
	case <-time.After(time.Second):
		t.Fatal("permit=off waited for a plugin open that ignores cancellation")
	}
	writerEntered := make(chan struct{})
	go func() {
		_, _ = withPluginWriteLock("example.peer", func() (any, error) {
			close(writerEntered)
			return nil, nil
		})
	}()
	select {
	case <-writerEntered:
		t.Fatal("plugin writer crossed an in-flight peer open after permit=off")
	case <-time.After(50 * time.Millisecond):
	}
	close(releaseOpen)
	select {
	case <-writerEntered:
	case <-time.After(time.Second):
		t.Fatal("failed peer open did not release its temporary plugin read lock")
	}
}

func TestPluginPeerInitialControlWriteKeepsReadLockAfterPermitTurnsOff(t *testing.T) {
	originalOpen := openPluginPeer
	originalResolve := resolveInstalledPluginPeerAction
	defer func() {
		openPluginPeer = originalOpen
		resolveInstalledPluginPeerAction = originalResolve
	}()
	writeStarted := make(chan struct{})
	releaseWrite := make(chan struct{})
	plugin := &blockingOpenControlPluginPeer{
		fakePluginPeer: newFakePluginPeer(), started: writeStarted, release: releaseWrite,
	}
	openPluginPeer = func(context.Context, string, string, string, string) (installedPlugin, pluginPeerIO, error) {
		return peerTestMeta(), plugin, nil
	}
	resolveInstalledPluginPeerAction = func(string, string, string, string) (installedPlugin, string, error) {
		return peerTestMeta(), "/test/plugin", nil
	}
	agent := &Agent{enabled: true, permit: PermitAllow, deviceID: "device-1", cfgPath: t.TempDir() + "/config.json"}
	if !agent.handlePluginPeerPrepare(context.Background(), func(context.Context, Envelope) error { return nil }, Envelope{
		V: 1, Type: "peer_session_prepare", Body: peerTestPrepareBody(t, peerTestRequest()),
	}) {
		t.Fatal("peer prepare rejected")
	}
	select {
	case <-writeStarted:
	case <-time.After(time.Second):
		t.Fatal("initial plugin control write did not start")
	}
	agent.setPermit(PermitOff)
	writerEntered := make(chan struct{})
	go func() {
		_, _ = withPluginWriteLock("example.peer", func() (any, error) {
			close(writerEntered)
			return nil, nil
		})
	}()
	select {
	case <-writerEntered:
		t.Fatal("plugin writer crossed a still-running initial control write")
	case <-time.After(50 * time.Millisecond):
	}
	close(releaseWrite)
	select {
	case <-writerEntered:
	case <-time.After(time.Second):
		t.Fatal("initial startup did not release its local plugin read lock")
	}
}

func TestPluginPeerFreshStartReusesSessionGuardBehindWaitingWriter(t *testing.T) {
	originalOpen := openPluginPeer
	defer func() { openPluginPeer = originalOpen }()
	opened := make(chan struct{}, 1)
	plugin := newFakePluginPeer()
	openPluginPeer = func(context.Context, string, string, string, string) (installedPlugin, pluginPeerIO, error) {
		opened <- struct{}{}
		return peerTestMeta(), plugin, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	guard := pluginOperationLock("example.peer")
	guard.RLock()
	roundID := "0ef1f797-f298-4f20-8248-5284858f46ef"
	s := &pluginPeerSession{
		agent: &Agent{}, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, approved: true,
		pluginID: "example.peer", pluginVer: "1.2.3", protocol: "example.bytes.v1",
		role: "source", signalRole: "initiator", action: "source", abi: pluginPeerABI,
		transport: "direct_ordered", approval: "both_once", pluginGuard: guard,
		epoch: &pluginPeerEpoch{roundID: roundID},
	}
	writerEntered := make(chan struct{})
	writerDone := make(chan struct{})
	go func() {
		guard.Lock()
		close(writerEntered)
		guard.Unlock()
		close(writerDone)
	}()
	deadline := time.Now().Add(time.Second)
	for {
		if !guard.TryRLock() {
			break
		}
		guard.RUnlock()
		if time.Now().After(deadline) {
			t.Fatal("writer never queued behind the session guard")
		}
		time.Sleep(time.Millisecond)
	}
	go s.startEpoch(roundID)
	select {
	case <-opened:
	case <-time.After(time.Second):
		t.Fatal("fresh peer round deadlocked by reacquiring its session read lock behind a writer")
	}
	s.close()
	select {
	case <-writerEntered:
	case <-time.After(time.Second):
		t.Fatal("peer close did not eventually release the session guard")
	}
	select {
	case <-writerDone:
	case <-time.After(time.Second):
		t.Fatal("waiting plugin writer did not finish")
	}
}

func TestPluginPeerGracefulCloseCancelsBeforeEpochContext(t *testing.T) {
	sessionCtx, sessionCancel := context.WithCancel(context.Background())
	epochCtx, epochCancel := context.WithCancel(sessionCtx)
	plugin := newContextWatchingPluginPeer(epochCtx)
	agent := &Agent{}
	s := &pluginPeerSession{
		agent: agent, ctx: sessionCtx, cancel: sessionCancel, sessionID: testPeerSessionID,
		epoch: &pluginPeerEpoch{ctx: epochCtx, cancel: epochCancel, plugin: plugin},
	}
	s.cancelPluginAndClose()
	select {
	case call := <-plugin.first:
		if call.kind != "cancel" || call.err != nil {
			t.Fatalf("first plugin stop=%s ctxErr=%v, want cancel before context cancellation", call.kind, call.err)
		}
	case <-time.After(time.Second):
		t.Fatal("plugin did not receive a stop")
	}
	if !errors.Is(epochCtx.Err(), context.Canceled) {
		t.Fatalf("epoch context was not canceled after graceful plugin stop: %v", epochCtx.Err())
	}
}

func TestPermitOffStartsAllPluginPeerShutdownsTogether(t *testing.T) {
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	agent := &Agent{}
	sessions := make([]*pluginPeerSession, 0, 2)
	for i := 0; i < 2; i++ {
		sessionCtx, sessionCancel := context.WithCancel(context.Background())
		epochCtx, epochCancel := context.WithCancel(sessionCtx)
		sessions = append(sessions, &pluginPeerSession{
			agent: agent, ctx: sessionCtx, cancel: sessionCancel,
			sessionID: fmt.Sprintf("session-%d", i), closed: false,
			epoch: &pluginPeerEpoch{
				roundID: fmt.Sprintf("round-%d", i), ctx: epochCtx, cancel: epochCancel,
				plugin: &blockingCancelPluginPeer{started: started, release: release},
			},
		})
	}
	done := make(chan struct{})
	go func() {
		rejectPluginPeers(sessions, "DEVICE_DISABLED")
		close(done)
	}()
	for i := 0; i < 2; i++ {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("permit=off serialized peer shutdown behind a blocking plugin")
		}
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("parallel peer shutdown did not finish")
	}
}

func TestAllPluginPeerShutdownModesStartTogether(t *testing.T) {
	tests := []struct {
		name     string
		plugin   func(chan<- struct{}, <-chan struct{}) pluginPeerIO
		shutdown func([]*pluginPeerSession)
	}{
		{
			name: "auth revoke cancel",
			plugin: func(started chan<- struct{}, release <-chan struct{}) pluginPeerIO {
				return &blockingCancelPluginPeer{started: started, release: release}
			},
			shutdown: cancelPluginPeers,
		},
		{
			name: "websocket loss abort",
			plugin: func(started chan<- struct{}, release <-chan struct{}) pluginPeerIO {
				return &blockingAbortPluginPeer{started: started, release: release}
			},
			shutdown: abortPluginPeers,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			started := make(chan struct{}, 2)
			release := make(chan struct{})
			sessions := make([]*pluginPeerSession, 0, 2)
			for i := 0; i < 2; i++ {
				sessionCtx, sessionCancel := context.WithCancel(context.Background())
				epochCtx, epochCancel := context.WithCancel(sessionCtx)
				sessions = append(sessions, &pluginPeerSession{
					agent: &Agent{}, ctx: sessionCtx, cancel: sessionCancel, sessionID: fmt.Sprintf("session-%d", i),
					epoch: &pluginPeerEpoch{ctx: epochCtx, cancel: epochCancel, plugin: tt.plugin(started, release)},
				})
			}
			done := make(chan struct{})
			go func() {
				tt.shutdown(sessions)
				close(done)
			}()
			for i := 0; i < 2; i++ {
				select {
				case <-started:
				case <-time.After(time.Second):
					t.Fatal("peer shutdown serialized behind another plugin")
				}
			}
			close(release)
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("parallel peer shutdown did not finish")
			}
		})
	}
}

func TestPluginPeerInterruptedReaderDrainsAndIgnoresOldOutput(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	plugin := newFakePluginPeer()
	e := &pluginPeerEpoch{roundID: testPeerRoundID, ctx: ctx, cancel: cancel, plugin: plugin, ready: true, interrupted: true}
	agent := &Agent{peerSessions: make(map[string]*pluginPeerSession)}
	events := make(chan Envelope, 1)
	s := &pluginPeerSession{
		agent: agent, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, epoch: e,
		sink: func(_ context.Context, env Envelope) error {
			events <- env
			return nil
		},
	}
	agent.peerSessions[testPeerSessionID] = s
	go s.readPlugin(e, plugin)
	plugin.read <- pluginPeerRecord{Kind: pluginPeerRecordJSON, Payload: []byte(`{`)}
	plugin.read <- pluginPeerRecord{Kind: pluginPeerRecordData, Payload: []byte("late data")}
	deadline := time.Now().Add(time.Second)
	for len(plugin.read) != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(10 * time.Millisecond)
	s.mu.Lock()
	stillRetained := !s.closed && s.epoch == e && e.plugin == plugin && e.interrupted && len(e.pendingData) == 0
	s.mu.Unlock()
	if !stillRetained {
		t.Fatal("late output from an interrupted plugin mutated or failed the retained epoch")
	}
	select {
	case env := <-events:
		t.Fatalf("interrupted plugin output emitted a terminal event: %#v", env)
	default:
	}
	s.cancelFromHub()
	close(plugin.read)
}

func TestPermitOffTerminatesPendingPluginPeer(t *testing.T) {
	originalOpen := openPluginPeer
	originalResolve := resolveInstalledPluginPeerAction
	defer func() {
		openPluginPeer = originalOpen
		resolveInstalledPluginPeerAction = originalResolve
	}()
	opened := make(chan struct{}, 1)
	openPluginPeer = func(context.Context, string, string, string, string) (installedPlugin, pluginPeerIO, error) {
		opened <- struct{}{}
		return peerTestMeta(), newFakePluginPeer(), nil
	}
	resolveInstalledPluginPeerAction = func(string, string, string, string) (installedPlugin, string, error) {
		return peerTestMeta(), "/test/plugin", nil
	}
	replies := make(chan Envelope, 2)
	agent := &Agent{enabled: true, permit: PermitAsk, deviceID: "device-1", cfgPath: t.TempDir() + "/config.json"}
	req := peerTestRequest()
	body, _ := json.Marshal(req)
	var mapped map[string]any
	_ = json.Unmarshal(body, &mapped)
	if !agent.handlePluginPeerPrepare(context.Background(), func(_ context.Context, env Envelope) error {
		replies <- env
		return nil
	}, Envelope{V: 1, Type: "peer_session_prepare", Body: mapped}) {
		t.Fatal("permit=ask rejected peer prepare")
	}
	agent.setPermit(PermitOff)
	select {
	case env := <-replies:
		if env.Type != "peer_session_event" || env.Body["event"] != "fail" || env.Body["failure_code"] != "DEVICE_DISABLED" {
			t.Fatalf("off terminal=%#v", env)
		}
	case <-time.After(time.Second):
		t.Fatal("permit=off did not terminate Worker peer session")
	}
	agent.mu.Lock()
	pending, sessions := agent.pending, len(agent.peerSessions)
	agent.mu.Unlock()
	if pending != nil || sessions != 0 {
		t.Fatalf("off retained pending=%#v sessions=%d", pending, sessions)
	}
	agent.approve()
	select {
	case <-opened:
		t.Fatal("revoked peer approval still opened the plugin")
	case <-time.After(50 * time.Millisecond):
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
	peerCancel := len(cancelDC.texts) != 0
	cancelDC.mu.Unlock()
	if peerCancel {
		t.Fatal("Hub cancellation was redundantly sent over the direct peer channel")
	}

	interrupted, epoch, round, interruptPlugin, interruptDC := newSession()
	interrupted.dataChannelFailure(round, interruptDC, errors.New("network lost"))
	interruptPlugin.mu.Lock()
	aborted, wasCanceled := interruptPlugin.aborted, interruptPlugin.canceled
	interruptPlugin.mu.Unlock()
	if aborted || wasCanceled {
		t.Fatal("network interruption stopped the plugin before the Hub chose resume or cancel")
	}
	interrupted.mu.Lock()
	stillOpen := !interrupted.closed && interrupted.epoch == epoch && epoch.interrupted && epoch.round == nil
	interrupted.mu.Unlock()
	if !stillOpen {
		t.Fatal("interruption destroyed the session instead of waiting for a fresh round")
	}
	interrupted.cancelFromHub()
	interruptPlugin.mu.Lock()
	wasCanceled = interruptPlugin.canceled
	interruptPlugin.mu.Unlock()
	if !wasCanceled {
		t.Fatal("Hub cancellation did not reach the plugin retained after interruption")
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

func TestPluginPeerCancelledDeliveryWaitsForLocalCleanupWithoutDirectSend(t *testing.T) {
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	epochCtx, epochCancel := context.WithCancel(ctx)
	plugin := &blockingCancelPluginPeer{started: started, release: release}
	dc := &fakePeerDC{}
	e := &pluginPeerEpoch{roundID: testPeerRoundID, ctx: epochCtx, cancel: epochCancel, plugin: plugin}
	r := &pluginPeerRound{epoch: e, ctx: epochCtx, cancel: func() {}, dc: dc, open: true, started: true}
	e.round = r
	agent := &Agent{peerSessions: make(map[string]*pluginPeerSession)}
	s := &pluginPeerSession{agent: agent, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, epoch: e}
	agent.peerSessions[testPeerSessionID] = s
	s.dataChannelFailure(r, dc, errors.New("transport closed before Hub cancellation arrived"))
	s.mu.Lock()
	retained := s.epoch == e && e.interrupted && e.round == nil && e.plugin == plugin
	s.mu.Unlock()
	if !retained {
		t.Fatal("transport interruption detached the only plugin that could clean resumable state")
	}

	// Model the old failure: an in-flight DATA send owns sendMu indefinitely.
	// Hub-authoritative cancellation must not wait for that direct channel.
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	acked := make(chan struct{}, 1)
	done := make(chan struct{})
	go func() {
		agent.handlePluginPeerDelivery(context.Background(), func(_ context.Context, env Envelope) error {
			if env.Type == "peer_session_ack" {
				acked <- struct{}{}
			}
			return nil
		}, Envelope{Type: "peer_session_update", Body: map[string]any{
			"session_id": testPeerSessionID, "delivery_id": "ps:update:cancelled",
			"phase": "cancelled", "session": map[string]any{
				"phase": "cancelled", "round": map[string]any{"id": testPeerRoundID},
			},
		}})
		close(done)
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("Hub cancellation waited behind the direct channel instead of starting local cleanup")
	}
	select {
	case <-acked:
		t.Fatal("cancel delivery was ACKed before FLPP cleanup completed")
	case <-time.After(25 * time.Millisecond):
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancel delivery did not finish after local cleanup")
	}
	select {
	case <-acked:
	default:
		t.Fatal("cancel delivery was not ACKed after local cleanup")
	}
	agent.mu.Lock()
	_, live := agent.peerSessions[testPeerSessionID]
	agent.mu.Unlock()
	if live || !errors.Is(epochCtx.Err(), context.Canceled) {
		t.Fatal("cancelled session remained live after its delivery was ACKed")
	}
	dc.mu.Lock()
	directNotices := len(dc.texts)
	dc.mu.Unlock()
	if directNotices != 0 {
		t.Fatal("Hub cancellation attempted a redundant direct-channel notice")
	}
}

func TestPluginPeerPermitShutdownFinishesAnAlreadyClaimedClose(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	epochCtx, epochCancel := context.WithCancel(ctx)
	plugin := newFakePluginPeer()
	agent := &Agent{peerSessions: make(map[string]*pluginPeerSession)}
	s := &pluginPeerSession{
		agent: agent, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, closed: true,
		epoch: &pluginPeerEpoch{roundID: testPeerRoundID, ctx: epochCtx, cancel: epochCancel, plugin: plugin},
	}
	agent.peerSessions[testPeerSessionID] = s
	<-s.rejectAndClose("DEVICE_DISABLED")
	plugin.mu.Lock()
	wasCanceled := plugin.canceled
	plugin.mu.Unlock()
	if !wasCanceled || !errors.Is(epochCtx.Err(), context.Canceled) {
		t.Fatal("permit shutdown treated a terminal claim as completed teardown")
	}
	agent.mu.Lock()
	_, live := agent.peerSessions[testPeerSessionID]
	agent.mu.Unlock()
	if live {
		t.Fatal("already-claimed session survived permit shutdown")
	}
}

func TestPluginPeerPermitOffDoesNotAckHubCancelBeforeCleanup(t *testing.T) {
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	epochCtx, epochCancel := context.WithCancel(ctx)
	plugin := &blockingCancelPluginPeer{started: started, release: release}
	agent := &Agent{
		enabled: true, permit: PermitAllow, cfgPath: t.TempDir() + "/config.json",
		peerSessions: make(map[string]*pluginPeerSession),
	}
	s := &pluginPeerSession{
		agent: agent, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID,
		epoch: &pluginPeerEpoch{roundID: testPeerRoundID, ctx: epochCtx, cancel: epochCancel, plugin: plugin},
	}
	agent.peerSessions[testPeerSessionID] = s
	offDone := make(chan struct{})
	go func() {
		agent.setPermit(PermitOff)
		close(offDone)
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("permit=off did not start local FLPP cancellation")
	}

	acked := make(chan struct{}, 1)
	deliveryDone := make(chan struct{})
	go func() {
		agent.handlePluginPeerDelivery(context.Background(), func(_ context.Context, env Envelope) error {
			if env.Type == "peer_session_ack" {
				acked <- struct{}{}
			}
			return nil
		}, Envelope{Type: "peer_session_update", Body: map[string]any{
			"session_id": testPeerSessionID, "delivery_id": "ps:update:permit-off-cancelled",
			"phase": "cancelled", "session": map[string]any{
				"phase": "cancelled", "round": map[string]any{"id": testPeerRoundID},
			},
		}})
		close(deliveryDone)
	}()
	select {
	case <-acked:
		t.Fatal("permit=off let a Hub cancel ACK pass before local cleanup")
	case <-time.After(25 * time.Millisecond):
	}
	close(release)
	for name, done := range map[string]<-chan struct{}{"permit shutdown": offDone, "delivery": deliveryDone} {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatalf("%s did not finish after local cleanup", name)
		}
	}
	select {
	case <-acked:
	default:
		t.Fatal("Hub cancellation was not ACKed after permit=off cleanup")
	}
	if plugin.cancels.Load() != 1 || plugin.aborts.Load() != 0 {
		t.Fatalf("permit=off cleanup used cancel=%d abort=%d, want exactly one graceful cancel", plugin.cancels.Load(), plugin.aborts.Load())
	}
}

func TestPluginPeerHubCancelDoesNotAckAnAbortThatAlreadyWon(t *testing.T) {
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	epochCtx, epochCancel := context.WithCancel(ctx)
	plugin := &blockingAbortPluginPeer{started: started, release: release}
	agent := &Agent{peerSessions: make(map[string]*pluginPeerSession)}
	s := &pluginPeerSession{
		agent: agent, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID,
		epoch: &pluginPeerEpoch{roundID: testPeerRoundID, ctx: epochCtx, cancel: epochCancel, plugin: plugin},
	}
	agent.peerSessions[testPeerSessionID] = s
	closeDone := make(chan struct{})
	go func() {
		s.close()
		close(closeDone)
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("WSS-loss Abort did not start")
	}

	acked := make(chan struct{}, 1)
	deliveryDone := make(chan struct{})
	go func() {
		agent.handlePluginPeerDelivery(context.Background(), func(_ context.Context, env Envelope) error {
			if env.Type == "peer_session_ack" {
				acked <- struct{}{}
			}
			return nil
		}, Envelope{Type: "peer_session_update", Body: map[string]any{
			"session_id": testPeerSessionID, "delivery_id": "ps:update:abort-won-cancelled",
			"phase": "cancelled", "session": map[string]any{
				"phase": "cancelled", "round": map[string]any{"id": testPeerRoundID},
			},
		}})
		close(deliveryDone)
	}()
	select {
	case <-acked:
		t.Fatal("cancelled delivery was ACKed while Abort was still running")
	case <-time.After(25 * time.Millisecond):
	}
	close(release)
	for name, done := range map[string]<-chan struct{}{"abort": closeDone, "delivery": deliveryDone} {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatalf("%s did not finish after Abort was released", name)
		}
	}
	select {
	case <-acked:
		t.Fatal("cancelled delivery treated a completed Abort as graceful Cancel")
	default:
	}
	if plugin.cancels.Load() != 0 || plugin.aborts.Load() != 1 {
		t.Fatalf("abort-won cleanup used cancel=%d abort=%d", plugin.cancels.Load(), plugin.aborts.Load())
	}
}

func TestPluginPeerUnknownCancelledDeliveryIsNotAcked(t *testing.T) {
	agent := &Agent{}
	acked := false
	agent.handlePluginPeerDelivery(context.Background(), func(_ context.Context, env Envelope) error {
		if env.Type == "peer_session_ack" {
			acked = true
		}
		return nil
	}, Envelope{Type: "peer_session_update", Body: map[string]any{
		"session_id": testPeerSessionID, "delivery_id": "ps:update:unknown-cancelled",
		"phase": "cancelled", "session": map[string]any{
			"phase": "cancelled", "round": map[string]any{"id": testPeerRoundID},
		},
	}})
	if acked || agent.peerDeliveries != nil {
		t.Fatal("unknown cancelled delivery was acknowledged without an FLPP owner")
	}
}

func TestPluginPeerOfflineCancelReopensAbortedCheckpointAndAcks(t *testing.T) {
	original := openPluginPeer
	defer func() { openPluginPeer = original }()
	cleanupPlugin := newFakePluginPeer()
	openPluginPeer = func(context.Context, string, string, string, string) (installedPlugin, pluginPeerIO, error) {
		return peerTestMeta(), cleanupPlugin, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	epochCtx, epochCancel := context.WithCancel(ctx)
	initial := newFakePluginPeer()
	agent := &Agent{peerSessions: make(map[string]*pluginPeerSession)}
	s := &pluginPeerSession{
		agent: agent, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID,
		pluginID: "example.peer", pluginVer: "1.2.3", protocol: "example.bytes.v1",
		role: "source", signalRole: "initiator", action: "source", abi: pluginPeerABI,
		transport: "direct_ordered", approval: "both_once",
		epoch: &pluginPeerEpoch{
			roundID: testPeerRoundID, ctx: epochCtx, cancel: epochCancel,
			plugin: initial, openApplied: true, ready: true,
		},
	}
	agent.peerSessions[testPeerSessionID] = s
	s.close()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		agent.mu.Lock()
		recovery := agent.peerCancelRecovery[testPeerSessionID]
		_, live := agent.peerSessions[testPeerSessionID]
		agent.mu.Unlock()
		if recovery == s && !live {
			break
		}
		time.Sleep(time.Millisecond)
	}
	initial.mu.Lock()
	initialAborted, initialCanceled := initial.aborted, initial.canceled
	initial.mu.Unlock()
	if !initialAborted || initialCanceled {
		t.Fatal("WSS loss did not preserve the checkpoint with Abort")
	}
	acked := false
	delivery := Envelope{Type: "peer_session_update", Body: map[string]any{
		"session_id": testPeerSessionID, "delivery_id": "ps:update:offline-cancelled",
		"phase": "cancelled", "session": map[string]any{
			"phase": "cancelled", "round": map[string]any{"id": testPeerRoundID},
		},
	}}
	sink := func(_ context.Context, env Envelope) error {
		if env.Type == "peer_session_ack" {
			acked = true
		}
		return nil
	}
	agent.handlePluginPeerDelivery(context.Background(), sink, delivery)
	if acked {
		t.Fatal("offline cancellation ACKed before background recovery produced a receipt")
	}
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		agent.mu.Lock()
		_, receipt := agent.peerCancelReceipts[testPeerSessionID]
		agent.mu.Unlock()
		if receipt {
			break
		}
		time.Sleep(time.Millisecond)
	}
	agent.handlePluginPeerDelivery(context.Background(), sink, delivery)
	cleanupPlugin.mu.Lock()
	cleanupCanceled := cleanupPlugin.canceled
	cleanupControls := len(cleanupPlugin.controls)
	cleanupPlugin.mu.Unlock()
	if !acked || !cleanupCanceled || cleanupControls != 2 {
		t.Fatalf("offline cleanup ack=%v canceled=%v controls=%d, want true/true/2", acked, cleanupCanceled, cleanupControls)
	}
}

func TestPluginPeerLateSuccessfulOpenAfterOfflineCloseRetainsRecovery(t *testing.T) {
	original := openPluginPeer
	defer func() { openPluginPeer = original }()
	openStarted := make(chan struct{})
	releaseOpen := make(chan struct{})
	initial := &lateSuccessfulOpenPluginPeer{
		fakePluginPeer: newFakePluginPeer(), started: openStarted, release: releaseOpen,
	}
	cleanup := newFakePluginPeer()
	var opens atomic.Int32
	openPluginPeer = func(context.Context, string, string, string, string) (installedPlugin, pluginPeerIO, error) {
		if opens.Add(1) == 1 {
			return peerTestMeta(), initial, nil
		}
		return peerTestMeta(), cleanup, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	agent := &Agent{peerSessions: make(map[string]*pluginPeerSession)}
	s := &pluginPeerSession{
		agent: agent, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, approved: true,
		pluginID: "example.peer", pluginVer: "1.2.3", protocol: "example.bytes.v1",
		role: "source", signalRole: "initiator", action: "source", abi: pluginPeerABI,
		transport: "direct_ordered", approval: "both_once", usedRounds: map[string]int{testPeerRoundID: 1},
	}
	agent.peerSessions[testPeerSessionID] = s
	go s.startEpoch(testPeerRoundID)
	select {
	case <-openStarted:
	case <-time.After(time.Second):
		t.Fatal("plugin Open control did not start")
	}
	_, cleanupDone := s.closeClaimed(false)
	close(releaseOpen)
	select {
	case <-cleanupDone:
	case <-time.After(time.Second):
		t.Fatal("offline close did not wait for the late Open result")
	}
	agent.mu.Lock()
	recovery := agent.peerCancelRecovery[testPeerSessionID]
	agent.mu.Unlock()
	if recovery != s {
		t.Fatal("late successful Open did not retain an offline cancellation owner")
	}
	if agent.handlePluginPeerUpdate(Envelope{Body: map[string]any{
		"session_id": testPeerSessionID,
		"phase":      "cancelled",
	}}) {
		t.Fatal("offline cancellation ACKed before recovery produced a receipt")
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		agent.mu.Lock()
		_, receipt := agent.peerCancelReceipts[testPeerSessionID]
		agent.mu.Unlock()
		if receipt {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if !agent.handlePluginPeerUpdate(Envelope{Body: map[string]any{
		"session_id": testPeerSessionID,
		"phase":      "cancelled",
	}}) {
		t.Fatal("recovered cancellation receipt was not replayable")
	}
	initial.mu.Lock()
	initialAborted := initial.aborted
	initial.mu.Unlock()
	cleanup.mu.Lock()
	cleanupCanceled := cleanup.canceled
	cleanupControls := len(cleanup.controls)
	cleanup.mu.Unlock()
	if !initialAborted || !cleanupCanceled || cleanupControls != 2 {
		t.Fatalf("cleanup aborted=%v canceled=%v controls=%d, want true/true/2", initialAborted, cleanupCanceled, cleanupControls)
	}
}

func TestPluginPeerAuthoritativeNonCancelTerminalDoesNotRecreateRecovery(t *testing.T) {
	for _, phase := range []string{"completed", "failed", "expired"} {
		t.Run(phase, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			epochCtx, epochCancel := context.WithCancel(ctx)
			plugin := newFakePluginPeer()
			agent := &Agent{peerSessions: make(map[string]*pluginPeerSession)}
			s := &pluginPeerSession{
				agent: agent, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID,
				epoch: &pluginPeerEpoch{
					roundID: testPeerRoundID, ctx: epochCtx, cancel: epochCancel,
					plugin: plugin, openApplied: true, ready: true,
				},
			}
			agent.peerSessions[testPeerSessionID] = s
			if !agent.handlePluginPeerUpdate(Envelope{Body: map[string]any{
				"session_id": testPeerSessionID,
				"phase":      phase,
			}}) {
				t.Fatalf("authoritative %s update was not handled", phase)
			}
			s.mu.Lock()
			cleanupDone := s.cleanupDone
			s.mu.Unlock()
			select {
			case <-cleanupDone:
			case <-time.After(time.Second):
				t.Fatalf("authoritative %s teardown did not finish", phase)
			}
			agent.mu.Lock()
			_, recovery := agent.peerCancelRecovery[testPeerSessionID]
			_, live := agent.peerSessions[testPeerSessionID]
			agent.mu.Unlock()
			plugin.mu.Lock()
			aborted, canceled := plugin.aborted, plugin.canceled
			plugin.mu.Unlock()
			if recovery || live || !aborted || canceled {
				t.Fatalf("%s cleanup recovery=%v live=%v aborted=%v canceled=%v", phase, recovery, live, aborted, canceled)
			}
		})
	}
}

func TestPluginPeerRepeatedRecoveryRemovalDoesNotEvictCurrentOwner(t *testing.T) {
	agent := &Agent{}
	for i := 0; i < 300; i++ {
		owner := &pluginPeerSession{sessionID: testPeerSessionID}
		agent.recordPluginPeerCancelRecovery(testPeerSessionID, owner)
		agent.clearPluginPeerCancelRecovery(testPeerSessionID)
	}
	current := &pluginPeerSession{sessionID: testPeerSessionID}
	agent.recordPluginPeerCancelRecovery(testPeerSessionID, current)
	agent.mu.Lock()
	got := agent.peerCancelRecovery[testPeerSessionID]
	order := append([]string(nil), agent.peerRecoveryOrder...)
	agent.mu.Unlock()
	if got != current || len(order) != 1 || order[0] != testPeerSessionID {
		t.Fatalf("current recovery=%p want=%p order=%q", got, current, order)
	}
}

func TestPluginPeerPrepareReplayTransfersOfflineCancelDebtBeforeAck(t *testing.T) {
	originalOpen := openPluginPeer
	originalResolve := resolveInstalledPluginPeerAction
	defer func() {
		openPluginPeer = originalOpen
		resolveInstalledPluginPeerAction = originalResolve
	}()

	startupStarted := make(chan struct{})
	releaseStartup := make(chan struct{})
	startupPlugin := newFakePluginPeer()
	cleanupPlugin := newFakePluginPeer()
	var opens atomic.Int32
	openPluginPeer = func(context.Context, string, string, string, string) (installedPlugin, pluginPeerIO, error) {
		if opens.Add(1) == 1 {
			close(startupStarted)
			<-releaseStartup
			return peerTestMeta(), startupPlugin, nil
		}
		return peerTestMeta(), cleanupPlugin, nil
	}
	resolveInstalledPluginPeerAction = func(string, string, string, string) (installedPlugin, string, error) {
		return peerTestMeta(), "/test/plugin", nil
	}

	agent := &Agent{
		enabled: true, permit: PermitAllow, deviceID: "device-1",
		peerSessions: make(map[string]*pluginPeerSession),
	}
	req := peerTestRequest()
	previous, err := newPluginPeerSession(agent, context.Background(), nil, req)
	if err != nil {
		t.Fatal(err)
	}
	previous.mu.Lock()
	previous.closed = true
	previous.cancelRequired = true
	previous.mu.Unlock()
	agent.peerCancelRecovery = map[string]*pluginPeerSession{req.SessionID: previous}
	agent.peerRecoveryOrder = []string{req.SessionID}

	acks := make(chan string, 4)
	sink := func(_ context.Context, reply Envelope) error {
		if reply.Type == "peer_session_ack" {
			deliveryID, _ := reply.Body["delivery_id"].(string)
			acks <- deliveryID
		}
		return nil
	}
	prepareBody := peerTestPrepareBody(t, req)
	prepareBody["delivery_id"] = "ps:prepare:offline-replay"
	agent.handlePluginPeerDelivery(context.Background(), sink, Envelope{
		V: 1, Type: "peer_session_prepare", Body: prepareBody,
	})
	select {
	case deliveryID := <-acks:
		if deliveryID != "ps:prepare:offline-replay" {
			t.Fatalf("unexpected prepare ACK %q", deliveryID)
		}
	case <-time.After(time.Second):
		t.Fatal("replayed prepare was not ACKed after taking recovery ownership")
	}
	select {
	case <-startupStarted:
	case <-time.After(time.Second):
		t.Fatal("replayed prepare did not start its replacement owner")
	}

	agent.mu.Lock()
	next := agent.peerSessions[req.SessionID]
	_, recoveryRetained := agent.peerCancelRecovery[req.SessionID]
	agent.mu.Unlock()
	if next == nil || next == previous || recoveryRetained {
		t.Fatalf("recovery transfer next=%p previous=%p retained=%v", next, previous, recoveryRetained)
	}
	next.mu.Lock()
	transferred := next.cancelRequired && !next.cancelApplied
	next.mu.Unlock()
	if !transferred {
		t.Fatal("replayed prepare ACKed without inheriting the offline cancellation debt")
	}

	cancelDone := make(chan struct{})
	go func() {
		agent.handlePluginPeerDelivery(context.Background(), sink, Envelope{V: 1, Type: "peer_session_update", Body: map[string]any{
			"session_id": req.SessionID, "delivery_id": "ps:update:cancel-after-replay",
			"phase": "cancelled", "session": map[string]any{
				"phase": "cancelled", "round": map[string]any{"id": req.RoundID},
			},
		}})
		close(cancelDone)
	}()
	select {
	case deliveryID := <-acks:
		t.Fatalf("cancel %q was ACKed before the replacement took FLPP ownership", deliveryID)
	case <-time.After(25 * time.Millisecond):
	}
	close(releaseStartup)
	select {
	case <-cancelDone:
	case <-time.After(time.Second):
		t.Fatal("cancel after prepare replay did not finish recovery")
	}
	select {
	case deliveryID := <-acks:
		if deliveryID != "ps:update:cancel-after-replay" {
			t.Fatalf("unexpected cancel ACK %q", deliveryID)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled delivery was not ACKed after replacement FLPP cleanup")
	}
	cleanupPlugin.mu.Lock()
	cleanupCanceled := cleanupPlugin.canceled
	cleanupControls := len(cleanupPlugin.controls)
	cleanupPlugin.mu.Unlock()
	if !cleanupCanceled || cleanupControls != 2 || opens.Load() != 2 {
		t.Fatalf("replacement cleanup canceled=%v controls=%d opens=%d, want true/2/2", cleanupCanceled, cleanupControls, opens.Load())
	}
	agent.mu.Lock()
	_, receipt := agent.peerCancelReceipts[req.SessionID]
	agent.mu.Unlock()
	if !receipt {
		t.Fatal("applied replacement cancellation did not publish its receipt")
	}
}

func TestPluginPeerPermitOffConsumesOfflineRecovery(t *testing.T) {
	original := openPluginPeer
	defer func() { openPluginPeer = original }()
	cleanupPlugin := newFakePluginPeer()
	openPluginPeer = func(context.Context, string, string, string, string) (installedPlugin, pluginPeerIO, error) {
		return peerTestMeta(), cleanupPlugin, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	epochCtx, epochCancel := context.WithCancel(ctx)
	initial := newFakePluginPeer()
	agent := &Agent{
		enabled: true, permit: PermitAllow, cfgPath: t.TempDir() + "/config.json",
		peerSessions: make(map[string]*pluginPeerSession),
	}
	s := &pluginPeerSession{
		agent: agent, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID,
		pluginID: "example.peer", pluginVer: "1.2.3", protocol: "example.bytes.v1",
		role: "source", signalRole: "initiator", action: "source", abi: pluginPeerABI,
		transport: "direct_ordered", approval: "both_once",
		epoch: &pluginPeerEpoch{
			roundID: testPeerRoundID, ctx: epochCtx, cancel: epochCancel,
			plugin: initial, openApplied: true, ready: true,
		},
	}
	agent.peerSessions[testPeerSessionID] = s
	s.close()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		agent.mu.Lock()
		recovery := agent.peerCancelRecovery[testPeerSessionID]
		_, live := agent.peerSessions[testPeerSessionID]
		agent.mu.Unlock()
		if recovery == s && !live {
			break
		}
		time.Sleep(time.Millisecond)
	}
	agent.setPermit(PermitOff)
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		agent.mu.Lock()
		_, receipt := agent.peerCancelReceipts[testPeerSessionID]
		_, recovery := agent.peerCancelRecovery[testPeerSessionID]
		agent.mu.Unlock()
		if receipt && !recovery {
			break
		}
		time.Sleep(time.Millisecond)
	}
	agent.mu.Lock()
	_, receipt := agent.peerCancelReceipts[testPeerSessionID]
	_, recovery := agent.peerCancelRecovery[testPeerSessionID]
	agent.mu.Unlock()
	cleanupPlugin.mu.Lock()
	cleanupCanceled := cleanupPlugin.canceled
	cleanupControls := len(cleanupPlugin.controls)
	cleanupPlugin.mu.Unlock()
	if !receipt || recovery || !cleanupCanceled || cleanupControls != 2 {
		t.Fatalf("permit recovery receipt=%v recovery=%v canceled=%v controls=%d", receipt, recovery, cleanupCanceled, cleanupControls)
	}
}

func TestPluginPeerOfflineRecoveryDoesNotBlockControlLoopOnPluginWriter(t *testing.T) {
	original := openPluginPeer
	defer func() { openPluginPeer = original }()
	cleanupPlugin := newFakePluginPeer()
	openPluginPeer = func(context.Context, string, string, string, string) (installedPlugin, pluginPeerIO, error) {
		return peerTestMeta(), cleanupPlugin, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &pluginPeerSession{
		agent: &Agent{}, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID,
		pluginID: "example.peer", pluginVer: "1.2.3", protocol: "example.bytes.v1",
		role: "source", signalRole: "initiator", action: "source", abi: pluginPeerABI,
		transport: "direct_ordered", approval: "both_once", cancelRequired: true,
	}
	agent := &Agent{peerCancelRecovery: map[string]*pluginPeerSession{testPeerSessionID: s}}
	s.agent = agent
	guard := pluginOperationLock("example.peer")
	guard.Lock()
	returned := make(chan bool, 1)
	go func() {
		returned <- agent.handlePluginPeerUpdate(Envelope{Body: map[string]any{
			"session_id": testPeerSessionID,
			"phase":      "cancelled",
		}})
	}()
	select {
	case handled := <-returned:
		if handled {
			t.Fatal("background recovery was acknowledged before it ran")
		}
	case <-time.After(100 * time.Millisecond):
		guard.Unlock()
		t.Fatal("offline recovery blocked the control loop behind a plugin writer")
	}
	guard.Unlock()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		agent.mu.Lock()
		_, receipt := agent.peerCancelReceipts[testPeerSessionID]
		agent.mu.Unlock()
		if receipt {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("background recovery did not finish after the plugin writer released")
}

func TestPluginPeerBlockedOpenWithUnappliedCancelIsNotAcked(t *testing.T) {
	original := openPluginPeer
	defer func() { openPluginPeer = original }()
	openStarted := make(chan struct{})
	releaseOpen := make(chan struct{})
	initial := &failingCancelPluginPeer{
		fakePluginPeer: newFakePluginPeer(), started: openStarted, release: releaseOpen,
	}
	retry := &failingCancelPluginPeer{fakePluginPeer: newFakePluginPeer()}
	var opens atomic.Int32
	openPluginPeer = func(context.Context, string, string, string, string) (installedPlugin, pluginPeerIO, error) {
		if opens.Add(1) == 1 {
			return peerTestMeta(), initial, nil
		}
		return peerTestMeta(), retry, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	agent := &Agent{peerSessions: make(map[string]*pluginPeerSession)}
	s := &pluginPeerSession{
		agent: agent, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, approved: true,
		pluginID: "example.peer", pluginVer: "1.2.3", protocol: "example.bytes.v1",
		role: "source", signalRole: "initiator", action: "source", abi: pluginPeerABI,
		transport: "direct_ordered", approval: "both_once", usedRounds: map[string]int{testPeerRoundID: 1},
	}
	agent.peerSessions[testPeerSessionID] = s
	go s.startEpoch(testPeerRoundID)
	select {
	case <-openStarted:
	case <-time.After(time.Second):
		t.Fatal("plugin Open control did not block")
	}
	receipt := make(chan bool, 1)
	go func() { receipt <- s.cancelFromHub() }()
	select {
	case got := <-receipt:
		t.Fatalf("cancellation returned before the in-flight Open settled: %v", got)
	case <-time.After(50 * time.Millisecond):
	}
	close(releaseOpen)
	select {
	case got := <-receipt:
		if got {
			t.Fatal("failed FLPP cancel was reported as applied")
		}
	case <-time.After(time.Second):
		t.Fatal("failed cancellation did not settle")
	}
	if initial.cancels.Load() == 0 || retry.cancels.Load() != 1 {
		t.Fatalf("cancel attempts initial=%d retry=%d, want initial>0 retry=1", initial.cancels.Load(), retry.cancels.Load())
	}
	agent.mu.Lock()
	_, recorded := agent.peerCancelReceipts[testPeerSessionID]
	agent.mu.Unlock()
	if recorded {
		t.Fatal("unapplied cancellation left a replayable receipt")
	}
}

func TestPluginPeerLateCancelReceiptSurvivesSessionDetach(t *testing.T) {
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	epochCtx, epochCancel := context.WithCancel(ctx)
	plugin := &blockingCancelPluginPeer{started: started, release: release}
	agent := &Agent{peerSessions: make(map[string]*pluginPeerSession)}
	s := &pluginPeerSession{
		agent: agent, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID,
		epoch: &pluginPeerEpoch{
			roundID: testPeerRoundID, ctx: epochCtx, cancel: epochCancel,
			plugin: plugin, openApplied: true,
		},
	}
	agent.peerSessions[testPeerSessionID] = s
	result := make(chan bool, 1)
	go func() { result <- s.cancelFromHub() }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("FLPP cancel did not start")
	}
	select {
	case got := <-result:
		if got {
			t.Fatal("timed-out cleanup was reported as complete")
		}
	case <-time.After(pluginPeerCleanupWait + time.Second):
		t.Fatal("Hub cancellation did not honor its cleanup deadline")
	}
	close(release)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		agent.mu.Lock()
		_, receipt := agent.peerCancelReceipts[testPeerSessionID]
		_, live := agent.peerSessions[testPeerSessionID]
		agent.mu.Unlock()
		if receipt && !live {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if !agent.handlePluginPeerUpdate(Envelope{Body: map[string]any{
		"session_id": testPeerSessionID,
		"phase":      "cancelled",
	}}) {
		t.Fatal("late successful cleanup was lost after session detach")
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
	if agent.peerSessions["session-a"] != pendingSession || agent.peerDeliveries == nil || agent.pending != nil {
		t.Fatal("shutdown detached a live session before teardown or retained its approval")
	}
	pendingSession.agent = agent
	agent.dropPluginPeer("session-a", pendingSession)
	if len(agent.peerSessions) != 0 || agent.peerDeliveries != nil || agent.peerDeliveryOrder != nil {
		t.Fatal("delivery dedupe survived the last session teardown")
	}
}

func TestPluginPeerPrepareReplayRebuildsStateAfterLostAckAndReconnect(t *testing.T) {
	originalOpen := openPluginPeer
	originalResolve := resolveInstalledPluginPeerAction
	opened := make(chan struct{}, 2)
	openPluginPeer = func(context.Context, string, string, string, string) (installedPlugin, pluginPeerIO, error) {
		opened <- struct{}{}
		return peerTestMeta(), newFakePluginPeer(), nil
	}
	resolveInstalledPluginPeerAction = func(string, string, string, string) (installedPlugin, string, error) {
		return peerTestMeta(), "/test/plugin", nil
	}
	defer func() {
		openPluginPeer = originalOpen
		resolveInstalledPluginPeerAction = originalResolve
	}()

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
	select {
	case <-opened:
	case <-time.After(time.Second):
		t.Fatal("first replay fixture did not finish reading openPluginPeer")
	}
	agent.mu.Lock()
	first := agent.peerSessions[testPeerSessionID]
	agent.pending = nil
	sessions := agent.takePluginPeersLocked()
	agent.mu.Unlock()
	if first == nil || len(sessions) != 1 {
		t.Fatal("first prepare was not applied before the ACK was lost")
	}
	abortPluginPeers(sessions)
	first.mu.Lock()
	cleanupDone := first.cleanupDone
	first.mu.Unlock()
	select {
	case <-cleanupDone:
	case <-time.After(time.Second):
		t.Fatal("first replay fixture did not finish local teardown")
	}
	acks := 0
	agent.handlePluginPeerDelivery(context.Background(), func(_ context.Context, reply Envelope) error {
		if reply.Type == "peer_session_ack" {
			acks++
		}
		return nil
	}, env)
	select {
	case <-opened:
	case <-time.After(time.Second):
		t.Fatal("replayed fixture did not finish reading openPluginPeer")
	}
	agent.mu.Lock()
	second := agent.peerSessions[testPeerSessionID]
	agent.mu.Unlock()
	if second == nil || second == first || acks != 1 {
		t.Fatalf("replay did not rebuild and ACK a fresh session: second=%p first=%p acks=%d", second, first, acks)
	}
	second.close()
}

func TestPluginPeerPrepareReplayDuringTeardownIsNotAcked(t *testing.T) {
	originalOpen := openPluginPeer
	originalResolve := resolveInstalledPluginPeerAction
	defer func() {
		openPluginPeer = originalOpen
		resolveInstalledPluginPeerAction = originalResolve
	}()
	opened := make(chan struct{}, 1)
	openPluginPeer = func(context.Context, string, string, string, string) (installedPlugin, pluginPeerIO, error) {
		opened <- struct{}{}
		return peerTestMeta(), newFakePluginPeer(), nil
	}
	resolveInstalledPluginPeerAction = func(string, string, string, string) (installedPlugin, string, error) {
		return peerTestMeta(), "/test/plugin", nil
	}
	abortStarted := make(chan struct{}, 1)
	releaseAbort := make(chan struct{})
	oldPlugin := &blockingAbortPluginPeer{started: abortStarted, release: releaseAbort}
	req := peerTestRequest()
	ctx, cancel := context.WithCancel(context.Background())
	epochCtx, epochCancel := context.WithCancel(ctx)
	agent := &Agent{
		enabled: true, permit: PermitAllow, deviceID: "device-1",
		peerSessions:      map[string]*pluginPeerSession{},
		peerDeliveries:    map[string]struct{}{"ps:prepare:teardown": {}},
		peerDeliveryOrder: []string{"ps:prepare:teardown"},
	}
	first := &pluginPeerSession{
		agent: agent, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, approved: true,
		pluginID: "example.peer", pluginVer: "1.2.3", protocol: "example.bytes.v1",
		role: "source", signalRole: "initiator", action: "source", abi: pluginPeerABI,
		transport: "direct_ordered", approval: "both_once",
		input: append(json.RawMessage(nil), req.Input...), operatorID: req.OperatorID,
		userID: req.UserID, peer: req.Peer, stunURLs: append([]string(nil), req.STUNURLs...),
		epoch: &pluginPeerEpoch{
			roundID: testPeerRoundID, ctx: epochCtx, cancel: epochCancel,
			plugin: oldPlugin, openApplied: true, ready: true,
		},
		usedRounds: map[string]int{testPeerRoundID: 1},
	}
	agent.peerSessions[testPeerSessionID] = first
	body, _ := json.Marshal(req)
	var mapped map[string]any
	_ = json.Unmarshal(body, &mapped)
	mapped["delivery_id"] = "ps:prepare:teardown"
	env := Envelope{V: 1, Type: "peer_session_prepare", Body: mapped}
	agent.mu.Lock()
	sessions := agent.takePluginPeersLocked()
	agent.mu.Unlock()
	teardownDone := make(chan struct{})
	go func() {
		abortPluginPeers(sessions)
		close(teardownDone)
	}()
	select {
	case <-abortStarted:
	case <-time.After(time.Second):
		t.Fatal("old plugin Abort did not start")
	}
	acks := 0
	agent.handlePluginPeerDelivery(context.Background(), func(_ context.Context, reply Envelope) error {
		if reply.Type == "peer_session_ack" {
			acks++
		}
		return nil
	}, env)
	if acks != 0 {
		t.Fatal("duplicate prepare was ACKed while its old owner was tearing down")
	}
	select {
	case <-opened:
		t.Fatal("duplicate prepare spawned a second plugin during teardown")
	default:
	}
	close(releaseAbort)
	select {
	case <-teardownDone:
	case <-time.After(time.Second):
		t.Fatal("old teardown did not finish")
	}
	first.mu.Lock()
	cleanupDone := first.cleanupDone
	first.mu.Unlock()
	select {
	case <-cleanupDone:
	case <-time.After(time.Second):
		t.Fatal("old teardown did not publish its recovery state")
	}
	agent.handlePluginPeerDelivery(context.Background(), func(_ context.Context, reply Envelope) error {
		if reply.Type == "peer_session_ack" {
			acks++
		}
		return nil
	}, env)
	select {
	case <-opened:
	case <-time.After(time.Second):
		t.Fatal("replayed prepare did not rebuild after teardown")
	}
	if acks != 1 {
		t.Fatalf("replayed prepare ACKs=%d, want 1 after rebuild", acks)
	}
	agent.mu.Lock()
	second := agent.peerSessions[testPeerSessionID]
	agent.mu.Unlock()
	if second == nil || second == first {
		t.Fatal("replayed prepare did not install a fresh session owner")
	}
	second.close()
}

func TestPluginPeerPrepareReplayRebuildsWhileAnotherSessionRemainsLive(t *testing.T) {
	originalOpen := openPluginPeer
	originalResolve := resolveInstalledPluginPeerAction
	defer func() {
		openPluginPeer = originalOpen
		resolveInstalledPluginPeerAction = originalResolve
	}()
	opened := make(chan struct{}, 1)
	openPluginPeer = func(context.Context, string, string, string, string) (installedPlugin, pluginPeerIO, error) {
		opened <- struct{}{}
		return peerTestMeta(), newFakePluginPeer(), nil
	}
	resolveInstalledPluginPeerAction = func(string, string, string, string) (installedPlugin, string, error) {
		return peerTestMeta(), "/test/plugin", nil
	}

	const deliveryID = "ps:prepare:multi-session-replay"
	first := &pluginPeerSession{sessionID: testPeerSessionID}
	other := &pluginPeerSession{sessionID: "session-b"}
	agent := &Agent{
		enabled: true, permit: PermitAllow, deviceID: "device-1",
		peerSessions: map[string]*pluginPeerSession{
			testPeerSessionID: first,
			other.sessionID:   other,
		},
		peerDeliveries:    map[string]struct{}{deliveryID: {}},
		peerDeliveryOrder: []string{deliveryID},
	}
	first.agent = agent
	agent.dropPluginPeer(testPeerSessionID, first)
	if agent.peerSessions[other.sessionID] != other || agent.peerDeliveries == nil {
		t.Fatal("dropping session A disturbed live session B or cleared the shared dedupe cache")
	}

	req := peerTestRequest()
	body, _ := json.Marshal(req)
	var mapped map[string]any
	_ = json.Unmarshal(body, &mapped)
	mapped["delivery_id"] = deliveryID
	acks := 0
	agent.handlePluginPeerDelivery(context.Background(), func(_ context.Context, reply Envelope) error {
		if reply.Type == "peer_session_ack" {
			acks++
		}
		return nil
	}, Envelope{V: 1, Type: "peer_session_prepare", Body: mapped})
	select {
	case <-opened:
	case <-time.After(time.Second):
		t.Fatal("session A replay stayed pinned by unrelated live session B")
	}

	agent.mu.Lock()
	second := agent.peerSessions[testPeerSessionID]
	otherAfter := agent.peerSessions[other.sessionID]
	_, deduped := agent.peerDeliveries[deliveryID]
	orderEntries := 0
	for _, id := range agent.peerDeliveryOrder {
		if id == deliveryID {
			orderEntries++
		}
	}
	agent.mu.Unlock()
	if second == nil || second == first || acks != 1 {
		t.Fatalf("session A was not rebuilt and ACKed: second=%p first=%p acks=%d", second, first, acks)
	}
	if otherAfter != other {
		t.Fatal("replaying session A replaced or removed unrelated session B")
	}
	if !deduped || orderEntries != 1 {
		t.Fatalf("replayed delivery cache state deduped=%v orderEntries=%d, want true/1", deduped, orderEntries)
	}
	second.close()
}

func TestPluginPeerFreshControlWriteTimeoutKeepsWriterOutUntilWriteReturns(t *testing.T) {
	originalOpen := openPluginPeer
	defer func() { openPluginPeer = originalOpen }()
	writeStarted := make(chan struct{})
	releaseWrite := make(chan struct{})
	newPlugin := &blockingOpenControlPluginPeer{
		fakePluginPeer: newFakePluginPeer(), started: writeStarted, release: releaseWrite,
	}
	openPluginPeer = func(context.Context, string, string, string, string) (installedPlugin, pluginPeerIO, error) {
		return peerTestMeta(), newPlugin, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	oldCtx, oldCancel := context.WithCancel(ctx)
	old := &pluginPeerEpoch{
		roundID: testPeerRoundID, ctx: oldCtx, cancel: oldCancel,
		plugin: newFakePluginPeer(), interrupted: true,
	}
	guard := pluginOperationLock("example.peer")
	guard.RLock()
	s := &pluginPeerSession{
		agent: &Agent{}, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, approved: true,
		pluginID: "example.peer", pluginVer: "1.2.3", protocol: "example.bytes.v1",
		role: "source", signalRole: "initiator", action: "source", abi: pluginPeerABI,
		transport: "direct_ordered", approval: "both_once", pluginGuard: guard, epoch: old,
		roundNo: 1, usedRounds: map[string]int{testPeerRoundID: 1},
	}
	nextRound := "0ef1f797-f298-4f20-8248-5284858f46ef"
	advanced := make(chan bool, 1)
	go func() { advanced <- s.beginNextRound(nextRound, 2, "source", "initiator") }()
	select {
	case <-writeStarted:
	case <-time.After(time.Second):
		t.Fatal("fresh plugin control write did not start")
	}
	writerEntered := make(chan struct{})
	go func() {
		guard.Lock()
		close(writerEntered)
		guard.Unlock()
	}()
	select {
	case <-writerEntered:
		t.Fatal("plugin writer crossed a still-running fresh control write")
	case <-time.After(50 * time.Millisecond):
	}
	select {
	case ok := <-advanced:
		if !ok {
			t.Fatal("valid fresh round was rejected")
		}
	case <-time.After(pluginPeerControlWait + time.Second):
		t.Fatal("fresh round blocked past the bounded control-write deadline")
	}
	select {
	case <-writerEntered:
		t.Fatal("timed-out control write released the plugin read lock too early")
	default:
	}
	close(releaseWrite)
	select {
	case <-writerEntered:
	case <-time.After(time.Second):
		t.Fatal("plugin writer remained blocked after control write returned")
	}
}

func TestPluginPeerFreshRoundRestartsPluginWithImmutableEpoch(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	oldPlugin := newFakePluginPeer()
	newPlugin := newFakePluginPeer()
	oldCtx, oldCancel := context.WithCancel(ctx)
	old := &pluginPeerEpoch{roundID: testPeerRoundID, ctx: oldCtx, cancel: oldCancel, plugin: oldPlugin, interrupted: true}
	s := &pluginPeerSession{
		agent: &Agent{}, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, approved: true,
		pluginID: "example.peer", pluginVer: "1.2.3", protocol: "example.bytes.v1",
		role: "source", signalRole: "initiator", action: "source", abi: pluginPeerABI, transport: "direct_ordered", approval: "both_once",
		peer: pluginPeerEndpoint{Kind: "tool", ID: "tool-1"}, epoch: old,
		roundNo: 1, usedRounds: map[string]int{testPeerRoundID: 1},
	}
	defer s.close()
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

func TestPluginPeerFreshRoundStopKeepsWriterOutAndCannotStartAfterClose(t *testing.T) {
	original := openPluginPeer
	defer func() { openPluginPeer = original }()
	abortStarted := make(chan struct{}, 1)
	releaseAbort := make(chan struct{})
	oldPlugin := &blockingAbortPluginPeer{started: abortStarted, release: releaseAbort}
	opened := make(chan struct{}, 1)
	openPluginPeer = func(context.Context, string, string, string, string) (installedPlugin, pluginPeerIO, error) {
		opened <- struct{}{}
		return peerTestMeta(), newFakePluginPeer(), nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	oldCtx, oldCancel := context.WithCancel(ctx)
	old := &pluginPeerEpoch{
		roundID: testPeerRoundID, ctx: oldCtx, cancel: oldCancel,
		plugin: oldPlugin, ready: true, interrupted: true,
	}
	guard := pluginOperationLock("example.peer")
	guard.RLock()
	agent := &Agent{peerSessions: make(map[string]*pluginPeerSession)}
	s := &pluginPeerSession{
		agent: agent, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, approved: true,
		pluginID: "example.peer", pluginVer: "1.2.3", protocol: "example.bytes.v1",
		role: "source", signalRole: "initiator", action: "source", abi: pluginPeerABI,
		transport: "direct_ordered", approval: "both_once", pluginGuard: guard, epoch: old,
		roundNo: 1, usedRounds: map[string]int{testPeerRoundID: 1},
	}
	agent.peerSessions[testPeerSessionID] = s
	nextRound := "0ef1f797-f298-4f20-8248-5284858f46ef"
	advanced := make(chan bool, 1)
	go func() { advanced <- s.beginNextRound(nextRound, 2, "source", "initiator") }()
	select {
	case <-abortStarted:
	case <-time.After(time.Second):
		t.Fatal("fresh round did not start retiring the old plugin")
	}
	select {
	case <-opened:
		t.Fatal("fresh plugin opened before the old process finished aborting")
	default:
	}

	s.close()
	writerEntered := make(chan struct{})
	go func() {
		_, _ = withPluginWriteLock("example.peer", func() (any, error) {
			close(writerEntered)
			return nil, nil
		})
	}()
	select {
	case <-writerEntered:
		t.Fatal("plugin writer crossed a still-running fresh-round retirement")
	case <-time.After(50 * time.Millisecond):
	}
	close(releaseAbort)
	select {
	case ok := <-advanced:
		if !ok {
			t.Fatal("valid fresh round was rejected")
		}
	case <-time.After(time.Second):
		t.Fatal("fresh round did not finish after old plugin abort")
	}
	select {
	case <-opened:
		t.Fatal("terminal close allowed a replacement plugin to open")
	default:
	}
	select {
	case <-writerEntered:
	case <-time.After(time.Second):
		t.Fatal("retired plugin did not release the session read lock")
	}
}

func TestPluginPeerHubCancelDuringFreshAbortResumesCheckpointBeforeReceipt(t *testing.T) {
	original := openPluginPeer
	defer func() { openPluginPeer = original }()
	abortStarted := make(chan struct{}, 1)
	releaseAbort := make(chan struct{})
	oldPlugin := &blockingAbortPluginPeer{started: abortStarted, release: releaseAbort}
	cleanupPlugin := newFakePluginPeer()
	openPluginPeer = func(context.Context, string, string, string, string) (installedPlugin, pluginPeerIO, error) {
		return peerTestMeta(), cleanupPlugin, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	oldCtx, oldCancel := context.WithCancel(ctx)
	old := &pluginPeerEpoch{
		roundID: testPeerRoundID, ctx: oldCtx, cancel: oldCancel,
		plugin: oldPlugin, openApplied: true, ready: true, interrupted: true,
	}
	guard := pluginOperationLock("example.peer")
	guard.RLock()
	agent := &Agent{peerSessions: make(map[string]*pluginPeerSession)}
	s := &pluginPeerSession{
		agent: agent, ctx: ctx, cancel: cancel, sessionID: testPeerSessionID, approved: true,
		pluginID: "example.peer", pluginVer: "1.2.3", protocol: "example.bytes.v1",
		role: "source", signalRole: "initiator", action: "source", abi: pluginPeerABI,
		transport: "direct_ordered", approval: "both_once", pluginGuard: guard, epoch: old,
		roundNo: 1, usedRounds: map[string]int{testPeerRoundID: 1},
	}
	agent.peerSessions[testPeerSessionID] = s
	nextRound := "0ef1f797-f298-4f20-8248-5284858f46ef"
	advanced := make(chan bool, 1)
	go func() { advanced <- s.beginNextRound(nextRound, 2, "source", "initiator") }()
	select {
	case <-abortStarted:
	case <-time.After(time.Second):
		t.Fatal("fresh round did not begin aborting the old process")
	}
	receipt := make(chan bool, 1)
	go func() { receipt <- s.cancelFromHub() }()
	select {
	case got := <-receipt:
		t.Fatalf("Hub cancellation returned before fresh retirement settled: %v", got)
	case <-time.After(50 * time.Millisecond):
	}
	close(releaseAbort)
	select {
	case ok := <-advanced:
		if !ok {
			t.Fatal("valid fresh round was rejected")
		}
	case <-time.After(time.Second):
		t.Fatal("fresh retirement did not finish")
	}
	select {
	case got := <-receipt:
		if !got {
			t.Fatal("replacement FLPP cancel was applied but no receipt was produced")
		}
	case <-time.After(time.Second):
		t.Fatal("Hub cancellation did not finish replacement cleanup")
	}
	if got := oldPlugin.aborts.Load(); got != 1 {
		t.Fatalf("old plugin aborts=%d, want 1", got)
	}
	if got := oldPlugin.cancels.Load(); got != 0 {
		t.Fatalf("already-aborted old plugin cancels=%d, want 0", got)
	}
	cleanupPlugin.mu.Lock()
	cleanupCanceled := cleanupPlugin.canceled
	cleanupControls := len(cleanupPlugin.controls)
	cleanupPlugin.mu.Unlock()
	if !cleanupCanceled || cleanupControls != 2 {
		t.Fatalf("replacement cleanup canceled=%v controls=%d, want true/2 (open + cancel)", cleanupCanceled, cleanupControls)
	}
	if !agent.handlePluginPeerUpdate(Envelope{Body: map[string]any{
		"session_id": testPeerSessionID,
		"phase":      "cancelled",
	}}) {
		t.Fatal("completed cancellation receipt was not replayable after session detach")
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
