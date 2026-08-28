package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	testTransferID = "e3407bcb-732a-45ee-80e2-0f95761b5b13"
	testSignalID   = "815739bb-bca5-48a9-aeee-2c16bbfe11de"
)

func TestFileDataChannelControlUsesSharedEnvelope(t *testing.T) {
	s := &fileTransferSession{
		transferID: testTransferID,
		role:       "source",
		sentOffset: 5,
		ackWake:    make(chan struct{}, 1),
	}
	// This is the exact shape emitted by Fleet Tool's fileEnvelope(). Keeping
	// the fixture literal makes a second, Agent-only control format impossible
	// to reintroduce unnoticed.
	toolACK := fmt.Sprintf(
		`{"v":1,"type":"file_ack","id":"815739bb-bca5-48a9-aeee-2c16bbfe11de","t":1800000000000,"body":{"transfer_id":%q,"committed":5}}`,
		testTransferID,
	)
	if err := s.handleFileControl([]byte(toolACK)); err != nil {
		t.Fatal(err)
	}
	if s.ackOffset != 5 {
		t.Fatalf("Tool committed ACK was not consumed: %d", s.ackOffset)
	}
	if err := s.handleFileControl([]byte(`{"v":1,"type":"file_ack","offset":5}`)); err == nil {
		t.Fatal("legacy flat control message must be rejected")
	}

	emitted := newFileDCControl("file_ack", testTransferID, fileDCControlBody{Committed: 5})
	raw := fileTestJSON(t, emitted)
	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	body, ok := wire["body"].(map[string]any)
	if !ok || body["transfer_id"] != testTransferID || body["committed"] != float64(5) {
		t.Fatalf("invalid shared control envelope: %#v", wire)
	}
	if _, leaked := wire["committed"]; leaked {
		t.Fatalf("control field escaped body: %#v", wire)
	}
}

func TestFileControlGoldenFrameIsSharedWithTool(t *testing.T) {
	raw, err := os.ReadFile("../fleet-tool/testdata/file-control-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	s := &fileTransferSession{
		transferID: testTransferID,
		role:       "source",
		sentOffset: fileChunkBytes,
		ackWake:    make(chan struct{}, 1),
	}
	if err := s.handleFileControl(raw); err != nil {
		t.Fatal(err)
	}
	if s.ackOffset != fileChunkBytes {
		t.Fatalf("shared Tool/Agent ACK fixture was not consumed: %d", s.ackOffset)
	}
}

func TestFileTransferAlwaysWaitsForLocalApproval(t *testing.T) {
	originalCheck := checkFileTransferPlugin
	checkFileTransferPlugin = func() error { return nil }
	defer func() { checkFileTransferPlugin = originalCheck }()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	replies := make(chan Envelope, 4)
	agent := &Agent{enabled: true, permit: PermitAllow, deviceID: "device-local"}
	agent.handleFilePrepare(ctx, func(_ context.Context, env Envelope) error {
		replies <- env
		return nil
	}, Envelope{V: 1, Type: "file_prepare", Corr: "request-1", Body: map[string]any{
		"transfer_id": testTransferID,
		"role":        "source",
		"path_hint":   "/tmp/source.bin",
		"operator_id": "operator-1",
		"user_id":     "user-1",
		"peer":        map[string]any{"kind": "tool", "id": "tool-1", "name": "Local Tool"},
	}})

	agent.mu.Lock()
	pending := agent.pending
	sessions := len(agent.fileTransfers)
	agent.mu.Unlock()
	if pending == nil || pending.File == nil || pending.Kind != pendingKindFileTransfer {
		t.Fatalf("permit=allow bypassed explicit file approval: %#v", pending)
	}
	if sessions != 1 {
		t.Fatalf("expected one reserved session, got %d", sessions)
	}

	agent.deny()
	select {
	case env := <-replies:
		if env.Type != "file_event" || env.Body["event"] != "fail" || env.Body["failure_code"] != "DENIED" {
			t.Fatalf("unexpected denial: %#v", env)
		}
	case <-time.After(time.Second):
		t.Fatal("denial was not reported")
	}
	agent.mu.Lock()
	sessions = len(agent.fileTransfers)
	agent.mu.Unlock()
	if sessions != 0 {
		t.Fatalf("denied transfer leaked %d sessions", sessions)
	}
}

func TestFileTransferStatementBindsEverySessionField(t *testing.T) {
	now := time.Now().UnixMilli()
	manifest := fileManifest{
		Name: "report.bin", Size: 2 * fileChunkBytes,
		SHA256: strings.Repeat("a", 64), ChunkSize: fileChunkBytes,
	}
	prefix := strings.Repeat("b", 64)
	s := &fileTransferSession{
		transferID: testTransferID, sid: testSignalID, role: "target",
		operatorID: "operator-1", userID: "user-1", peer: filePeer{Kind: "tool", ID: "tool-1"},
		manifest: manifest, resume: fileChunkBytes, prefixHash: prefix,
		offer: testFingerprintSDP("11"), answer: testFingerprintSDP("22"),
	}
	statement := fileTransferStatement{
		V: 1, Kind: "file_transfer", TransferID: testTransferID, SID: testSignalID,
		UserID: "user-1", Kid: "kid-1", OperatorID: "operator-1",
		SourceKind: "tool", SourceID: "tool-1", TargetKind: "device", TargetID: "device-local",
		OffererKind: "tool", OffererID: "tool-1", AnswererKind: "device", AnswererID: "device-local",
		FileName: manifest.Name, FileSize: manifest.Size, FileSHA256: manifest.SHA256, ChunkSize: fileChunkBytes,
		ResumeOffset: fileChunkBytes, PrefixSHA256: prefix,
		OfferFP: rtcFingerprint(s.offer), AnswerFP: rtcFingerprint(s.answer), DirectOnly: true,
		Iat: now - 100, Exp: now + 1_000,
	}
	if err := validateFileTransferStatement(s, statement, testSignalID, "kid-1", "device-local", now); err != nil {
		t.Fatal(err)
	}

	cases := map[string]func(*fileTransferStatement){
		"sid":         func(v *fileTransferStatement) { v.SID = testTransferID },
		"operator":    func(v *fileTransferStatement) { v.OperatorID = "other" },
		"peer":        func(v *fileTransferStatement) { v.SourceID = "other"; v.OffererID = "other" },
		"manifest":    func(v *fileTransferStatement) { v.FileSHA256 = strings.Repeat("c", 64) },
		"resume":      func(v *fileTransferStatement) { v.ResumeOffset = 0 },
		"fingerprint": func(v *fileTransferStatement) { v.AnswerFP = strings.Repeat("f", 64) },
		"relay":       func(v *fileTransferStatement) { v.DirectOnly = false },
		"ttl":         func(v *fileTransferStatement) { v.Exp = v.Iat + 60_001 },
		"same_endpoint": func(v *fileTransferStatement) {
			v.SourceKind, v.SourceID = "device", "device-local"
			v.OffererKind, v.OffererID = "device", "device-local"
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			changed := statement
			mutate(&changed)
			if err := validateFileTransferStatement(s, changed, testSignalID, "kid-1", "device-local", now); err == nil {
				t.Fatal("mismatched signed statement accepted")
			}
		})
	}
}

func TestSourcePumpUsesFixedFramesAndFourMiBAckWindow(t *testing.T) {
	size := int64(fileAckBytes + 17)
	manifest := fileManifest{Name: "large.bin", Size: size, SHA256: strings.Repeat("d", 64), ChunkSize: fileChunkBytes}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	plugin := &fakeSourceFilePlugin{size: size}
	s := &fileTransferSession{
		ctx: ctx, cancel: cancel, role: "source", manifest: manifest,
		transferID: testTransferID,
		plugin:     plugin, authorized: true, open: true, started: true,
		ackWake: make(chan struct{}, 1),
	}
	dc := &fakeFileDataChannel{}
	dc.onData = func(raw []byte) error {
		frame, err := decodeFileFrame(raw)
		if err != nil {
			return err
		}
		end := int64(frame.Offset) + int64(len(frame.Payload))
		if end%fileAckBytes == 0 || end == size {
			return s.noteFileAck(end)
		}
		return nil
	}
	s.dc = dc
	if err := s.sourcePump(); err != nil {
		t.Fatal(err)
	}
	frames := dc.binaryFrames()
	if len(frames) != fileAckBytes/fileChunkBytes+1 {
		t.Fatalf("unexpected frame count %d", len(frames))
	}
	for i, raw := range frames {
		frame, err := decodeFileFrame(raw)
		if err != nil {
			t.Fatal(err)
		}
		want := fileChunkBytes
		if i == len(frames)-1 {
			want = 17
		}
		if len(frame.Payload) != want || frame.Offset != uint64(i*fileChunkBytes) {
			t.Fatalf("frame %d: offset=%d bytes=%d", i, frame.Offset, len(frame.Payload))
		}
	}
	controls := dc.textControls(t)
	if len(controls) != 1 || controls[0].Type != "file_eof" || controls[0].Body.Size != size || controls[0].Body.TransferID != testTransferID {
		t.Fatalf("missing eof after acknowledgements: %#v", controls)
	}
}

func TestTargetCommitsBeforeAdvertisingCompletion(t *testing.T) {
	manifest := fileManifest{Name: "small.bin", Size: 5, SHA256: strings.Repeat("e", 64), ChunkSize: fileChunkBytes}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	plugin := &fakeTargetFilePlugin{}
	dc := &fakeFileDataChannel{}
	events := make(chan Envelope, 4)
	agent := &Agent{}
	s := &fileTransferSession{
		agent: agent, ctx: ctx, cancel: cancel, sink: func(_ context.Context, env Envelope) error { events <- env; return nil },
		transferID: testTransferID, role: "target", manifest: manifest,
		plugin: plugin, dc: dc, authorized: true, open: true,
	}
	payload := []byte("hello")
	frame, err := encodeFileFrame(0, payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.handleFileData(frame); err != nil {
		t.Fatal(err)
	}
	if err := s.handleFileControl(fileTestJSON(t, newFileDCControl("file_eof", testTransferID, fileDCControlBody{Size: 5, SHA256: manifest.SHA256}))); err != nil {
		t.Fatal(err)
	}
	control, _, _, committed, waited, _ := plugin.snapshot()
	if !committed || !waited {
		t.Fatalf("completion escaped before target commit: control=%q committed=%v waited=%v", control, committed, waited)
	}
	controls := dc.textControls(t)
	if len(controls) != 2 || controls[0].Type != "file_ack" || controls[1].Type != "file_complete" {
		t.Fatalf("unexpected target controls: %#v", controls)
	}
	if err := s.handleFileControl(fileTestJSON(t, newFileDCControl("file_complete_ack", testTransferID, fileDCControlBody{Size: 5, SHA256: manifest.SHA256}))); err != nil {
		t.Fatal(err)
	}
	select {
	case env := <-events:
		if env.Type != "file_event" || env.Body["event"] != "complete" {
			t.Fatalf("unexpected completion event: %#v", env)
		}
	case <-time.After(time.Second):
		t.Fatal("target completion event missing")
	}
	s.close()
}

func TestFileReaderSurvivesAnInterruptedRound(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	manifest := fileManifest{Name: "resume.bin", Size: fileChunkBytes + 5, SHA256: strings.Repeat("f", 64), ChunkSize: fileChunkBytes}
	firstPlugin := &fakeTargetFilePlugin{}
	firstDC := &fakeFileDataChannel{textErr: errors.New("round one closed")}
	agent := &Agent{fileTransfers: make(map[string]*fileTransferSession)}
	s := &fileTransferSession{
		agent: agent, ctx: ctx, cancel: cancel,
		transferID: testTransferID, sid: testSignalID, role: "target", manifest: manifest,
		plugin: firstPlugin, dc: firstDC, authorized: true, open: true, started: true,
		expectedOffset: 0, lastAck: -fileAckBytes,
		incoming: make(chan fileIncoming, 4), authWake: make(chan struct{}, 1), ackWake: make(chan struct{}, 1),
	}
	agent.fileTransfers[testTransferID] = s
	go s.readIncoming()
	frame, err := encodeFileFrame(0, make([]byte, fileChunkBytes))
	if err != nil {
		t.Fatal(err)
	}
	s.incoming <- fileIncoming{data: frame, sid: testSignalID}
	waitForFileTest(t, func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.interrupted
	})

	secondPlugin := &fakeTargetFilePlugin{}
	secondDC := &fakeFileDataChannel{}
	secondSID := "715739bb-bca5-48a9-aeee-2c16bbfe11de"
	s.mu.Lock()
	s.sid = secondSID
	s.plugin = secondPlugin
	s.dc = secondDC
	s.authorized = true
	s.open = true
	s.started = true
	s.interrupted = false
	s.expectedOffset = 0
	s.lastAck = -fileAckBytes
	s.mu.Unlock()
	s.incoming <- fileIncoming{data: frame, sid: secondSID}
	waitForFileTest(t, func() bool {
		control, _, _, _, _, _ := secondPlugin.snapshot()
		return control == "chunk"
	})
	controls := secondDC.textControls(t)
	if len(controls) != 1 || controls[0].Type != "file_ack" || controls[0].Body.Committed != fileChunkBytes {
		t.Fatalf("resumed reader did not consume the new channel: %#v", controls)
	}
}

func TestExpiredTransferDeletesTargetPartialState(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	plugin := &fakeTargetFilePlugin{}
	agent := &Agent{fileTransfers: make(map[string]*fileTransferSession)}
	s := &fileTransferSession{
		agent: agent, ctx: ctx, cancel: cancel,
		transferID: testTransferID, role: "target", plugin: plugin,
	}
	agent.fileTransfers[testTransferID] = s
	agent.handleFileUpdate(Envelope{V: 1, Type: "file_update", Body: map[string]any{
		"transfer_id": testTransferID,
		"phase":       "expired",
	}})
	waitForFileTest(t, func() bool {
		_, _, _, _, _, aborted := plugin.snapshot()
		return aborted
	})
	agent.mu.Lock()
	defer agent.mu.Unlock()
	if agent.fileTransfers[testTransferID] != nil {
		t.Fatal("expired transfer still occupies an Agent session")
	}
}

func TestFilePrepareTreatsTargetHintAsDirectory(t *testing.T) {
	req, err := decodeFilePrepare(map[string]any{
		"transfer_id": testTransferID, "role": "target", "path_hint": "/tmp/inbox",
		"operator_id": "operator-1", "user_id": "user-1",
		"peer":     map[string]any{"kind": "device", "id": "source-device"},
		"manifest": map[string]any{"name": "photo.jpg", "size": 0, "sha256": strings.Repeat("0", 64), "chunk_size": fileChunkBytes},
	})
	if err != nil {
		t.Fatal(err)
	}
	if req.PathHint != "/tmp/inbox" || req.Manifest == nil || req.Manifest.Name != "photo.jpg" {
		t.Fatalf("target directory or source name lost: %#v", req)
	}
}

func TestInterruptedTargetRepreparesResumeAndRejectsOldSID(t *testing.T) {
	originalOpen := openFileTransferPlugin
	prefix := strings.Repeat("9", 64)
	reopened := &fakePrepareTargetPlugin{resume: fileChunkBytes, prefix: prefix}
	openFileTransferPlugin = func(_ context.Context, action string, _ json.RawMessage) (filePluginIO, error) {
		if action != "prepare_target" {
			return nil, fmt.Errorf("unexpected action %q", action)
		}
		return reopened, nil
	}
	defer func() { openFileTransferPlugin = originalOpen }()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	roundCtx, roundCancel := context.WithCancel(ctx)
	replies := make(chan Envelope, 2)
	manifest := fileManifest{Name: "resume.bin", Size: 2 * fileChunkBytes, SHA256: strings.Repeat("8", 64), ChunkSize: fileChunkBytes}
	oldPlugin := &fakeTargetFilePlugin{}
	agent := &Agent{}
	s := &fileTransferSession{
		agent: agent, ctx: ctx, cancel: cancel, roundCtx: roundCtx, roundCancel: roundCancel,
		sink:       func(_ context.Context, env Envelope) error { replies <- env; return nil },
		transferID: testTransferID, sid: testSignalID, role: "target", pathHint: "/tmp/inbox",
		operatorID: "operator-1", userID: "user-1", peer: filePeer{Kind: "device", ID: "source-device"},
		manifest: manifest, plugin: oldPlugin, approved: true, prepared: true, authorized: true,
		started: true, usedSIDs: map[string]struct{}{testSignalID: {}}, incoming: make(chan fileIncoming, 128), ackWake: make(chan struct{}, 1),
	}
	s.interruptRound()
	_, _, _, _, _, aborted := oldPlugin.snapshot()
	if !aborted {
		t.Fatal("interrupt did not stop target process while preserving its persisted partial")
	}
	s.mu.Lock()
	if !s.interrupted || s.prepared || s.plugin != nil || s.sid != "" {
		t.Fatalf("target round was not reset: %#v", s)
	}
	if s.reserveSIDLocked(testSignalID) {
		t.Fatal("old signaling sid was reusable after interruption")
	}
	newSID, err := newFileSID()
	if err != nil || newSID == testSignalID || !s.reserveSIDLocked(newSID) {
		t.Fatalf("new signaling sid was not accepted: sid=%q err=%v", newSID, err)
	}
	s.mu.Unlock()

	req := filePrepareRequest{
		TransferID: testTransferID, Role: "target", PathHint: "/tmp/inbox",
		OperatorID: "operator-1", UserID: "user-1", Peer: filePeer{Kind: "device", ID: "source-device"},
		Manifest: &manifest,
	}
	if !s.acceptReprepare(req, s.sink) {
		t.Fatal("interrupted target rejected the exact immutable reprepare request")
	}
	s.approve()
	select {
	case env := <-replies:
		resume, _ := env.Body["preparation"].(map[string]any)["resume"].(map[string]any)
		if env.Type != "file_prepared" || resume["offset"] != int64(fileChunkBytes) || resume["prefix_sha256"] != prefix {
			t.Fatalf("new target resume was not advertised: %#v", env)
		}
	case <-time.After(time.Second):
		t.Fatal("target did not reprepare after interruption")
	}
	s.close()
}

func TestFilePeerBindingDoesNotPersistRawIdentity(t *testing.T) {
	peer := filePeer{Kind: "device", ID: "sensitive-device-id"}
	binding := filePeerBinding(peer)
	if !isSHA256(binding) || strings.Contains(binding, peer.ID) || binding != filePeerBinding(peer) {
		t.Fatalf("unsafe or unstable peer binding %q", binding)
	}
}

func testFingerprintSDP(pair string) string {
	parts := make([]string, 32)
	for i := range parts {
		parts[i] = pair
	}
	return "v=0\r\na=fingerprint:sha-256 " + strings.Join(parts, ":") + "\r\n"
}

func fileTestJSON(t *testing.T, value any) []byte {
	t.Helper()
	b, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

type fakeFileDataChannel struct {
	mu      sync.Mutex
	binary  [][]byte
	texts   []string
	onData  func([]byte) error
	textErr error
}

func (f *fakeFileDataChannel) Send(value []byte) error {
	f.mu.Lock()
	f.binary = append(f.binary, append([]byte(nil), value...))
	f.mu.Unlock()
	if f.onData != nil {
		return f.onData(value)
	}
	return nil
}

func (f *fakeFileDataChannel) SendText(value string) error {
	f.mu.Lock()
	if f.textErr != nil {
		err := f.textErr
		f.textErr = nil
		f.mu.Unlock()
		return err
	}
	f.texts = append(f.texts, value)
	f.mu.Unlock()
	return nil
}

func (f *fakeFileDataChannel) BufferedAmount() uint64 { return 0 }
func (f *fakeFileDataChannel) ReadyState() webrtc.DataChannelState {
	return webrtc.DataChannelStateOpen
}

func (f *fakeFileDataChannel) binaryFrames() [][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]byte(nil), f.binary...)
}

func (f *fakeFileDataChannel) textControls(t *testing.T) []fileDCControl {
	t.Helper()
	f.mu.Lock()
	values := append([]string(nil), f.texts...)
	f.mu.Unlock()
	out := make([]fileDCControl, 0, len(values))
	for _, value := range values {
		var control fileDCControl
		if err := json.Unmarshal([]byte(value), &control); err != nil {
			t.Fatal(err)
		}
		out = append(out, control)
	}
	return out
}

type fakeSourceFilePlugin struct {
	size     int64
	offset   int64
	length   int
	finished bool
	aborted  bool
}

func (f *fakeSourceFilePlugin) WriteJSON(value any) error {
	b, _ := json.Marshal(value)
	var control struct {
		Type   string `json:"type"`
		Offset int64  `json:"offset"`
		Length int    `json:"length"`
	}
	if err := json.Unmarshal(b, &control); err != nil {
		return err
	}
	if control.Type != "read" {
		return fmt.Errorf("unexpected source control %q", control.Type)
	}
	f.offset, f.length = control.Offset, control.Length
	return nil
}

func fakeBytes(offset int64, length int) []byte {
	value := make([]byte, length)
	for i := range value {
		value[i] = byte((offset + int64(i)) % 251)
	}
	return value
}

func (f *fakeSourceFilePlugin) ReadJSON(dst any) error {
	payload := fakeBytes(f.offset, f.length)
	sum := sha256.Sum256(payload)
	return remarshal(map[string]any{
		"v": 1, "type": "chunk", "offset": f.offset, "length": f.length, "sha256": hex.EncodeToString(sum[:]),
	}, dst)
}

func (f *fakeSourceFilePlugin) ReadRaw(dst []byte) error {
	copy(dst, fakeBytes(f.offset, len(dst)))
	return nil
}
func (f *fakeSourceFilePlugin) WriteRaw([]byte) error { return errors.New("source received raw bytes") }
func (f *fakeSourceFilePlugin) Finish() error         { f.finished = true; return nil }
func (f *fakeSourceFilePlugin) Wait() error           { return nil }
func (f *fakeSourceFilePlugin) Cancel() error         { return errors.New("source cannot cancel as target") }
func (f *fakeSourceFilePlugin) Abort()                { f.aborted = true }

type fakeTargetFilePlugin struct {
	mu        sync.Mutex
	control   string
	offset    int64
	length    int
	committed bool
	waited    bool
	aborted   bool
}

func (f *fakeTargetFilePlugin) WriteJSON(value any) error {
	b, _ := json.Marshal(value)
	var control struct {
		Type   string `json:"type"`
		Offset int64  `json:"offset"`
		Length int    `json:"length"`
	}
	if err := json.Unmarshal(b, &control); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.control, f.offset, f.length = control.Type, control.Offset, control.Length
	if control.Type == "commit" {
		f.committed = true
	}
	return nil
}

func (f *fakeTargetFilePlugin) WriteRaw(value []byte) error {
	f.mu.Lock()
	control, length := f.control, f.length
	f.mu.Unlock()
	if control != "chunk" || len(value) != length {
		return errors.New("target raw bytes do not match chunk header")
	}
	return nil
}

func (f *fakeTargetFilePlugin) ReadJSON(dst any) error {
	f.mu.Lock()
	control, offset, length := f.control, f.offset, f.length
	f.mu.Unlock()
	switch control {
	case "chunk":
		return remarshal(map[string]any{"v": 1, "type": "ack", "offset": offset + int64(length)}, dst)
	case "commit":
		return remarshal(map[string]any{"v": 1, "type": "complete", "path": "/tmp/small.bin"}, dst)
	default:
		return fmt.Errorf("unexpected target control %q", control)
	}
}

func (f *fakeTargetFilePlugin) ReadRaw([]byte) error { return errors.New("target emitted raw bytes") }
func (f *fakeTargetFilePlugin) Finish() error        { return errors.New("target must exit after commit") }
func (f *fakeTargetFilePlugin) Wait() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.waited = true
	return nil
}
func (f *fakeTargetFilePlugin) Cancel() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.aborted = true
	return nil
}
func (f *fakeTargetFilePlugin) Abort() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.aborted = true
}

func (f *fakeTargetFilePlugin) snapshot() (string, int64, int, bool, bool, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.control, f.offset, f.length, f.committed, f.waited, f.aborted
}

func remarshal(value, dst any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, dst)
}

func waitForFileTest(t *testing.T, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if ready() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("timed out waiting for file transfer state")
}

type fakePrepareTargetPlugin struct {
	resume  int64
	prefix  string
	aborted bool
}

func (f *fakePrepareTargetPlugin) ReadJSON(dst any) error {
	return remarshal(map[string]any{
		"v": 1, "type": "ready", "resume_offset": f.resume, "prefix_sha256": f.prefix,
	}, dst)
}
func (f *fakePrepareTargetPlugin) ReadRaw([]byte) error  { return errors.New("unexpected raw read") }
func (f *fakePrepareTargetPlugin) WriteJSON(any) error   { return nil }
func (f *fakePrepareTargetPlugin) WriteRaw([]byte) error { return nil }
func (f *fakePrepareTargetPlugin) Finish() error         { return nil }
func (f *fakePrepareTargetPlugin) Wait() error           { return nil }
func (f *fakePrepareTargetPlugin) Cancel() error         { return nil }
func (f *fakePrepareTargetPlugin) Abort()                { f.aborted = true }
