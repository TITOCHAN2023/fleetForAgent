package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	pendingKindFileTransfer = "file_transfer"
	fileTransferPluginID    = "fleet.transfer"
	fileTransferSessionMax  = 2
	fileSignalMax           = 128 << 10
	fileControlMax          = 64 << 10
	fileGatherTimeout       = 10 * time.Second
	fileMaxSafeInteger      = int64(1<<53 - 1)
)

var errFileDirect = errors.New("direct file transport failed")

type fileManifest struct {
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	SHA256    string `json:"sha256"`
	ChunkSize int    `json:"chunk_size"`
}

type filePeer struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
}

type filePrepareRequest struct {
	TransferID string        `json:"transfer_id"`
	Role       string        `json:"role"`
	PathHint   string        `json:"path_hint"`
	OperatorID string        `json:"operator_id"`
	UserID     string        `json:"user_id"`
	Peer       filePeer      `json:"peer"`
	STUNURLs   []string      `json:"stun_urls,omitempty"`
	Manifest   *fileManifest `json:"manifest,omitempty"`
}

type fileSignal struct {
	Kind          string  `json:"kind"`
	Seq           int     `json:"seq"`
	SDP           string  `json:"sdp,omitempty"`
	Candidate     string  `json:"candidate,omitempty"`
	SDPMid        string  `json:"sdp_mid,omitempty"`
	SDPMLineIndex *uint16 `json:"sdp_mline_index,omitempty"`
}

type fileSignalEnvelope struct {
	TransferID string     `json:"transfer_id"`
	Role       string     `json:"role"`
	SID        string     `json:"sid"`
	Signal     fileSignal `json:"signal"`
}

type fileTransferStatement struct {
	V            int    `json:"v"`
	Kind         string `json:"kind"`
	TransferID   string `json:"transfer_id"`
	SID          string `json:"sid"`
	UserID       string `json:"user_id"`
	Kid          string `json:"kid"`
	OperatorID   string `json:"operator_id"`
	SourceKind   string `json:"source_kind"`
	SourceID     string `json:"source_id"`
	TargetKind   string `json:"target_kind"`
	TargetID     string `json:"target_id"`
	OffererKind  string `json:"offerer_kind"`
	OffererID    string `json:"offerer_id"`
	AnswererKind string `json:"answerer_kind"`
	AnswererID   string `json:"answerer_id"`
	FileName     string `json:"file_name"`
	FileSize     int64  `json:"file_size"`
	FileSHA256   string `json:"file_sha256"`
	ChunkSize    int    `json:"chunk_size"`
	ResumeOffset int64  `json:"resume_offset"`
	PrefixSHA256 string `json:"prefix_sha256"`
	OfferFP      string `json:"offer_fp"`
	AnswerFP     string `json:"answer_fp"`
	DirectOnly   bool   `json:"direct_only"`
	Iat          int64  `json:"iat"`
	Exp          int64  `json:"exp"`
}

type filePendingApproval struct {
	approve func()
	deny    func(error)
}

type fileDataChannel interface {
	Send([]byte) error
	SendText(string) error
	BufferedAmount() uint64
	ReadyState() webrtc.DataChannelState
}

type filePluginIO interface {
	ReadJSON(any) error
	ReadRaw([]byte) error
	WriteJSON(any) error
	WriteRaw([]byte) error
	Finish() error
	Wait() error
	Cancel() error
	Abort()
}

type processFilePlugin struct {
	stream *pluginStream
	mu     sync.Mutex
}

func (p *processFilePlugin) ReadJSON(dst any) error { return p.stream.ReadJSONLine(dst) }

func (p *processFilePlugin) ReadRaw(dst []byte) error {
	_, err := io.ReadFull(p.stream.Stdout(), dst)
	return err
}

func (p *processFilePlugin) WriteJSON(value any) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(payload)+1 > pluginStreamLine {
		return errors.New("plugin stream JSON line exceeds 64 KiB")
	}
	payload = append(payload, '\n')
	_, err = p.stream.Stdin().Write(payload)
	return err
}

func (p *processFilePlugin) WriteRaw(value []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	_, err := p.stream.Stdin().Write(value)
	return err
}

func (p *processFilePlugin) Finish() error {
	if err := p.WriteJSON(map[string]any{"v": 1, "type": "close"}); err != nil {
		p.Abort()
		return err
	}
	var reply struct {
		V    int    `json:"v"`
		Type string `json:"type"`
	}
	if err := p.ReadJSON(&reply); err != nil || reply.V != 1 || reply.Type != "done" {
		p.Abort()
		if err != nil {
			return err
		}
		return errors.New("plugin did not finish cleanly")
	}
	_ = p.stream.Stdin().Close()
	return p.stream.Wait()
}

func (p *processFilePlugin) Wait() error { return p.stream.Wait() }

func (p *processFilePlugin) Cancel() error {
	if err := p.WriteJSON(map[string]any{"v": 1, "type": "cancel"}); err != nil {
		p.Abort()
		return err
	}
	var reply struct {
		V    int    `json:"v"`
		Type string `json:"type"`
	}
	if err := p.ReadJSON(&reply); err != nil || reply.V != 1 || reply.Type != "canceled" {
		p.Abort()
		if err != nil {
			return err
		}
		return errors.New("target plugin did not cancel cleanly")
	}
	_ = p.stream.Stdin().Close()
	return p.stream.Wait()
}

func (p *processFilePlugin) Abort() { _ = p.stream.Close() }

var openFileTransferPlugin = func(ctx context.Context, action string, input json.RawMessage) (filePluginIO, error) {
	stream, err := startPluginStream(ctx, fileTransferPluginID, action, input)
	if err != nil {
		return nil, err
	}
	return &processFilePlugin{stream: stream}, nil
}

var checkFileTransferPlugin = func() error {
	meta, _, _, err := trustedInstalledPlugin(fileTransferPluginID)
	if err != nil {
		return err
	}
	if !containsString(meta.Actions, "prepare_source") || !containsString(meta.Actions, "prepare_target") {
		return errors.New("fleet.transfer does not expose the streaming actions")
	}
	return nil
}

func fileTransferPluginReady() bool { return checkFileTransferPlugin() == nil }

type fileIncoming struct {
	text bool
	data []byte
	sid  string
}

type fileTransferSession struct {
	mu        sync.Mutex
	sendMu    sync.Mutex
	pluginMu  sync.Mutex
	closeOnce sync.Once

	agent       *Agent
	ctx         context.Context
	cancel      context.CancelFunc
	roundCtx    context.Context
	roundCancel context.CancelFunc
	sink        EnvelopeSink
	transferID  string
	sid         string
	role        string
	pathHint    string
	operatorID  string
	userID      string
	peer        filePeer
	stunURLs    []string
	manifest    fileManifest
	resume      int64
	prefixHash  string
	offer       string
	answer      string
	queuedSID   string
	queuedOffer string
	usedSIDs    map[string]struct{}
	ticket      *fileTransferStatement
	pc          *webrtc.PeerConnection
	dc          fileDataChannel
	plugin      filePluginIO
	incoming    chan fileIncoming
	authWake    chan struct{}

	approved           bool
	prepared           bool
	authorizing        bool
	authorized         bool
	open               bool
	readySent          bool
	started            bool
	offering           bool
	interrupted        bool
	interruptRequested bool
	readStarted        bool
	committed          bool
	completed          bool
	closed             bool
	sentOffset         int64
	ackOffset          int64
	expectedOffset     int64
	lastAck            int64
	ackWake            chan struct{}
}

func decodeFilePrepare(body map[string]any) (filePrepareRequest, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return filePrepareRequest{}, err
	}
	var req filePrepareRequest
	if err := json.Unmarshal(b, &req); err != nil {
		return req, err
	}
	req.TransferID = strings.TrimSpace(req.TransferID)
	req.Role = strings.TrimSpace(req.Role)
	req.PathHint = filepath.Clean(strings.TrimSpace(req.PathHint))
	req.OperatorID = strings.TrimSpace(req.OperatorID)
	req.UserID = strings.TrimSpace(req.UserID)
	req.Peer.Kind = strings.TrimSpace(req.Peer.Kind)
	req.Peer.ID = strings.TrimSpace(req.Peer.ID)
	req.Peer.Name = strings.TrimSpace(req.Peer.Name)
	if !rtcSIDPattern.MatchString(req.TransferID) {
		return req, errors.New("invalid transfer_id")
	}
	if req.Role != "source" && req.Role != "target" {
		return req, errors.New("invalid file transfer role")
	}
	if !filepath.IsAbs(req.PathHint) {
		return req, errors.New("file transfer path must be absolute")
	}
	if !validFileIdentity(req.OperatorID) || !validFileIdentity(req.UserID) || !validFilePeer(req.Peer) {
		return req, errors.New("invalid file transfer identity")
	}
	if req.Role == "target" {
		if req.Manifest == nil {
			return req, errors.New("target manifest required")
		}
		if err := validateFileManifest(*req.Manifest); err != nil {
			return req, err
		}
	}
	req.STUNURLs = cleanFileSTUNURLs(req.STUNURLs)
	return req, nil
}

func validFileIdentity(value string) bool { return value != "" && len(value) <= 128 }

func validFilePeer(peer filePeer) bool {
	return (peer.Kind == "device" || peer.Kind == "tool") && validFileIdentity(peer.ID) && len(peer.Name) <= 256
}

func validateFileManifest(manifest fileManifest) error {
	if manifest.Name == "" || len(manifest.Name) > 255 || manifest.Name != filepath.Base(manifest.Name) ||
		strings.ContainsAny(manifest.Name, `/\\`) {
		return errors.New("invalid file name")
	}
	if manifest.Size < 0 || manifest.Size > fileMaxSafeInteger || manifest.ChunkSize != fileChunkBytes || !isSHA256(manifest.SHA256) {
		return errors.New("invalid file manifest")
	}
	manifest.SHA256 = strings.ToLower(manifest.SHA256)
	return nil
}

func isSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func validResume(manifest fileManifest, offset int64, prefix string) bool {
	return offset >= 0 && offset <= manifest.Size && (offset == manifest.Size || offset%fileChunkBytes == 0) && isSHA256(prefix)
}

func cleanFileSTUNURLs(values []string) []string {
	out := make([]string, 0, 4)
	for _, value := range values {
		value = strings.TrimSpace(value)
		if strings.HasPrefix(value, "stun:") && len(value) <= 512 {
			out = append(out, value)
		}
		if len(out) == 4 {
			break
		}
	}
	return out
}

func newFileTransferSession(a *Agent, ctx context.Context, sink EnvelopeSink, req filePrepareRequest) *fileTransferSession {
	sessionCtx, cancel := context.WithCancel(ctx)
	roundCtx, roundCancel := context.WithCancel(sessionCtx)
	manifest := fileManifest{}
	if req.Manifest != nil {
		manifest = *req.Manifest
		manifest.SHA256 = strings.ToLower(manifest.SHA256)
	}
	return &fileTransferSession{
		agent: a, ctx: sessionCtx, cancel: cancel, roundCtx: roundCtx, roundCancel: roundCancel, sink: sink,
		transferID: req.TransferID, role: req.Role, pathHint: req.PathHint,
		operatorID: req.OperatorID, userID: req.UserID, peer: req.Peer,
		stunURLs: append([]string(nil), req.STUNURLs...), manifest: manifest,
		incoming: make(chan fileIncoming, fileAckBytes/fileChunkBytes),
		ackWake:  make(chan struct{}, 1),
		authWake: make(chan struct{}, 1),
	}
}

func (a *Agent) handleFilePrepare(ctx context.Context, sink EnvelopeSink, env Envelope) {
	req, err := decodeFilePrepare(env.Body)
	if err != nil {
		a.sendFileFailure(ctx, sink, fmt.Sprint(env.Body["transfer_id"]), "invalid_prepare")
		return
	}
	if err := checkFileTransferPlugin(); err != nil {
		a.mu.Lock()
		a.log("warn", "file transfer unavailable: "+err.Error())
		a.mu.Unlock()
		a.sendFileFailure(ctx, sink, req.TransferID, "plugin_unavailable")
		return
	}
	a.mu.Lock()
	if a.authRevoked || !a.enabled || a.permit == PermitOff {
		a.mu.Unlock()
		a.sendFileFailure(ctx, sink, req.TransferID, "device_disabled")
		return
	}
	if a.fileTransfers == nil {
		a.fileTransfers = make(map[string]*fileTransferSession)
	}
	if existing := a.fileTransfers[req.TransferID]; existing != nil {
		if a.pending != nil || !existing.acceptReprepare(req, sink) {
			a.mu.Unlock()
			a.sendFileFailure(ctx, sink, req.TransferID, "duplicate_transfer")
			return
		}
		label := a.queueFileApprovalLocked(existing, env.Corr, sink)
		a.mu.Unlock()
		notifyConsent(label)
		a.pushUI()
		return
	}
	if len(a.fileTransfers) >= fileTransferSessionMax || a.pending != nil {
		a.mu.Unlock()
		a.sendFileFailure(ctx, sink, req.TransferID, "session_limit")
		return
	}
	s := newFileTransferSession(a, ctx, sink, req)
	a.fileTransfers[req.TransferID] = s
	label := a.queueFileApprovalLocked(s, env.Corr, sink)
	a.mu.Unlock()
	notifyConsent(label)
	a.pushUI()
	go func() {
		<-s.ctx.Done()
		a.dropFileTransfer(s.transferID, s)
	}()
}

// queueFileApprovalLocked is called with a.mu held. File transfer never
// inherits permit=allow: each endpoint (and each resumed target round) asks a
// person at that machine.
func (a *Agent) queueFileApprovalLocked(s *fileTransferSession, corr string, sink EnvelopeSink) string {
	label := s.consentText()
	a.pending = &Pending{
		Kind: pendingKindFileTransfer, Corr: corr, Command: label, Requested: time.Now().UnixMilli(), Sink: sink,
		File: &filePendingApproval{
			approve: func() { s.approve() },
			deny:    func(err error) { s.fail("denied", err) },
		},
	}
	a.log("warn", "waiting consent: "+label)
	return label
}

func (s *fileTransferSession) acceptReprepare(req filePrepareRequest, sink EnvelopeSink) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || !s.interrupted || s.role != "target" || req.Role != "target" || s.plugin != nil ||
		s.pathHint != req.PathHint || s.operatorID != req.OperatorID || s.userID != req.UserID ||
		s.peer.Kind != req.Peer.Kind || s.peer.ID != req.Peer.ID || req.Manifest == nil ||
		s.manifest.Name != req.Manifest.Name || s.manifest.Size != req.Manifest.Size ||
		s.manifest.SHA256 != strings.ToLower(req.Manifest.SHA256) || s.manifest.ChunkSize != req.Manifest.ChunkSize {
		return false
	}
	s.sink = sink
	s.stunURLs = append(s.stunURLs[:0], req.STUNURLs...)
	return true
}

func (s *fileTransferSession) consentText() string {
	peer := s.peer.Name
	if peer == "" {
		peer = s.peer.Kind + ":" + s.peer.ID
	}
	if s.role == "source" {
		return fmt.Sprintf("send file %q directly to %q", s.pathHint, peer)
	}
	return fmt.Sprintf("receive %d bytes directly from %q into %q (will not overwrite)", s.manifest.Size, peer, filepath.Join(s.pathHint, s.manifest.Name))
}

func (s *fileTransferSession) approve() {
	s.mu.Lock()
	if s.closed || s.approved {
		s.mu.Unlock()
		return
	}
	s.approved = true
	s.interrupted = false
	s.mu.Unlock()
	go s.preparePlugin()
}

func (s *fileTransferSession) preparePlugin() {
	var err error
	if s.role == "source" {
		err = s.prepareSource()
	} else {
		err = s.prepareTarget()
	}
	if err != nil && !errors.Is(err, context.Canceled) {
		s.fail("plugin_error", err)
	}
}

func (s *fileTransferSession) prepareSource() error {
	input, _ := json.Marshal(map[string]any{"path": s.pathHint, "chunk_size": fileChunkBytes})
	plugin, err := openFileTransferPlugin(s.ctx, "prepare_source", input)
	if err != nil {
		return err
	}
	var ready struct {
		V        int          `json:"v"`
		Type     string       `json:"type"`
		Manifest fileManifest `json:"manifest"`
	}
	if err := plugin.ReadJSON(&ready); err != nil || ready.V != 1 || ready.Type != "ready" {
		plugin.Abort()
		if err != nil {
			return err
		}
		return errors.New("source plugin did not return ready")
	}
	if err := validateFileManifest(ready.Manifest); err != nil {
		plugin.Abort()
		return err
	}
	ready.Manifest.SHA256 = strings.ToLower(ready.Manifest.SHA256)
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		plugin.Abort()
		return context.Canceled
	}
	s.plugin = plugin
	s.manifest = ready.Manifest
	s.prepared = true
	s.mu.Unlock()
	if err := s.sendPrepared(map[string]any{"file": ready.Manifest}); err != nil {
		return err
	}
	return nil
}

func (s *fileTransferSession) prepareTarget() error {
	input := s.targetPluginInput()
	plugin, err := openFileTransferPlugin(s.ctx, "prepare_target", input)
	if err != nil {
		return err
	}
	var ready struct {
		V            int    `json:"v"`
		Type         string `json:"type"`
		ResumeOffset int64  `json:"resume_offset"`
		PrefixSHA256 string `json:"prefix_sha256"`
	}
	if err := plugin.ReadJSON(&ready); err != nil || ready.V != 1 || ready.Type != "ready" ||
		!validResume(s.manifest, ready.ResumeOffset, ready.PrefixSHA256) {
		plugin.Abort()
		if err != nil {
			return err
		}
		return errors.New("target plugin returned invalid resume state")
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		plugin.Abort()
		return context.Canceled
	}
	s.plugin = plugin
	s.resume = ready.ResumeOffset
	s.prefixHash = strings.ToLower(ready.PrefixSHA256)
	s.expectedOffset = ready.ResumeOffset
	s.lastAck = ready.ResumeOffset
	s.prepared = true
	queuedSID, queuedOffer := s.queuedSID, s.queuedOffer
	s.queuedSID, s.queuedOffer = "", ""
	s.mu.Unlock()
	if err := s.sendPrepared(map[string]any{"resume": map[string]any{
		"offset": ready.ResumeOffset, "prefix_sha256": strings.ToLower(ready.PrefixSHA256),
	}}); err != nil {
		return err
	}
	if queuedOffer != "" {
		return s.acceptOffer(queuedSID, queuedOffer)
	}
	return nil
}

func (s *fileTransferSession) targetPluginInput() json.RawMessage {
	input, _ := json.Marshal(map[string]any{
		"directory": s.pathHint, "name": s.manifest.Name, "manifest": s.manifest,
		"transfer_id": s.transferID, "source": filePeerBinding(s.peer),
	})
	return input
}

func filePeerBinding(peer filePeer) string {
	digest := sha256.Sum256([]byte(peer.Kind + "\x00" + peer.ID))
	return hex.EncodeToString(digest[:])
}

func (s *fileTransferSession) sendPrepared(preparation map[string]any) error {
	return s.sendControl(Envelope{
		V: 1, Type: "file_prepared", ID: newFileMessageID(), T: time.Now().UnixMilli(),
		Body: map[string]any{"transfer_id": s.transferID, "role": s.role, "preparation": preparation},
	})
}

func (s *fileTransferSession) sendEvent(event, code string) {
	body := map[string]any{"transfer_id": s.transferID, "event": event}
	if code != "" {
		body["failure_code"] = strings.ToUpper(code)
	}
	_ = s.sendControl(Envelope{V: 1, Type: "file_event", ID: newFileMessageID(), T: time.Now().UnixMilli(), Body: body})
}

func (s *fileTransferSession) sendControl(env Envelope) error {
	if s.sink == nil {
		return errors.New("file transfer control channel unavailable")
	}
	return s.sink(s.ctx, env)
}

func (a *Agent) sendFileFailure(ctx context.Context, sink EnvelopeSink, transferID, code string) {
	if sink == nil || transferID == "" {
		return
	}
	_ = sink(ctx, Envelope{V: 1, Type: "file_event", ID: newFileMessageID(), T: time.Now().UnixMilli(), Body: map[string]any{
		"transfer_id": transferID, "event": "fail", "failure_code": strings.ToUpper(code),
	}})
}

func newFileMessageID() string { return fmt.Sprintf("%d", time.Now().UnixNano()) }

func newFileSID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

func (s *fileTransferSession) peerConnection() (*webrtc.PeerConnection, error) {
	servers := make([]webrtc.ICEServer, 0, 1)
	if len(s.stunURLs) > 0 {
		servers = append(servers, webrtc.ICEServer{URLs: append([]string(nil), s.stunURLs...)})
	}
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: servers})
	if err != nil {
		return nil, err
	}
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		s.mu.Lock()
		current := s.pc == pc && !s.interrupted && !s.closed
		started := s.started
		s.mu.Unlock()
		if current && (state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateDisconnected) {
			err := fmt.Errorf("%w: connection %s", errFileDirect, state.String())
			if started {
				s.requestInterrupt(err)
			} else {
				s.fail("direct_connection_failed", err)
			}
		}
	})
	return pc, nil
}

func (s *fileTransferSession) createOffer() error {
	sid, err := newFileSID()
	if err != nil {
		return err
	}
	pc, err := s.peerConnection()
	if err != nil {
		return err
	}
	dc, err := pc.CreateDataChannel(fileChannelLabel, nil)
	if err != nil {
		_ = pc.Close()
		return err
	}
	s.mu.Lock()
	if s.closed || s.role != "source" || s.pc != nil {
		s.mu.Unlock()
		_ = pc.Close()
		return errors.New("file offer is not allowed in this state")
	}
	if !s.reserveSIDLocked(sid) {
		s.mu.Unlock()
		_ = pc.Close()
		return errors.New("file signaling sid was already used")
	}
	s.sid = sid
	s.pc = pc
	s.offering = false
	s.interrupted = false
	s.mu.Unlock()
	s.attachDataChannel(dc)
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		return err
	}
	if err := waitFileGather(s.ctx, gathered); err != nil {
		return err
	}
	local := pc.LocalDescription()
	if local == nil || !validDirectSDP(local.SDP) {
		return errors.New("invalid or relayed file offer")
	}
	s.mu.Lock()
	s.offer = local.SDP
	s.mu.Unlock()
	return s.sendSignal("source", sid, fileSignal{Kind: "offer", Seq: 0, SDP: local.SDP})
}

func (s *fileTransferSession) beginOffer() {
	s.mu.Lock()
	if s.closed || s.role != "source" || !s.prepared || s.plugin == nil || s.pc != nil || s.offering {
		s.mu.Unlock()
		return
	}
	s.offering = true
	s.interrupted = false
	s.mu.Unlock()
	go func() {
		if err := s.createOffer(); err != nil && !errors.Is(err, context.Canceled) {
			s.fail("signal_error", err)
		}
	}()
}

func waitFileGather(ctx context.Context, gathered <-chan struct{}) error {
	timer := time.NewTimer(fileGatherTimeout)
	defer timer.Stop()
	select {
	case <-gathered:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return errors.New("file ICE gathering timeout")
	}
}

func validDirectSDP(sdp string) bool {
	return len(sdp) > 0 && len(sdp) <= fileSignalMax && rtcFingerprint(sdp) != "" &&
		!strings.Contains(strings.ToLower(sdp), " typ relay") && !strings.Contains(strings.ToLower(sdp), "turn:")
}

func (s *fileTransferSession) sendSignal(role, sid string, signal fileSignal) error {
	return s.sendControl(Envelope{
		V: 1, Type: "file_signal", ID: newFileMessageID(), T: time.Now().UnixMilli(),
		Body: map[string]any{"transfer_id": s.transferID, "role": role, "sid": sid, "signal": signal},
	})
}

func (a *Agent) handleFileSignal(_ context.Context, _ EnvelopeSink, env Envelope) {
	b, err := json.Marshal(env.Body)
	if err != nil {
		return
	}
	var message fileSignalEnvelope
	if json.Unmarshal(b, &message) != nil || !rtcSIDPattern.MatchString(message.TransferID) ||
		!rtcSIDPattern.MatchString(message.SID) || message.Signal.Seq < 0 {
		return
	}
	a.mu.Lock()
	s := a.fileTransfers[message.TransferID]
	a.mu.Unlock()
	if s == nil {
		return
	}
	if message.Signal.Kind == "candidate" {
		// V1 gathers the complete offer/answer. Trickle candidates are not
		// accepted, which also prevents a TURN candidate from sneaking in.
		return
	}
	if !validDirectSDP(message.Signal.SDP) {
		s.fail("invalid_signal", errors.New("invalid direct file signal"))
		return
	}
	if s.role == "target" && message.Role == "source" && message.Signal.Kind == "offer" {
		s.mu.Lock()
		prepared := s.prepared
		if !prepared && s.queuedOffer == "" {
			s.queuedSID, s.queuedOffer = message.SID, message.Signal.SDP
		}
		s.mu.Unlock()
		if prepared {
			go func() {
				if err := s.acceptOffer(message.SID, message.Signal.SDP); err != nil {
					s.fail("signal_error", err)
				}
			}()
		}
		return
	}
	if s.role == "source" && message.Role == "target" && message.Signal.Kind == "answer" {
		if err := s.acceptAnswer(message.SID, message.Signal.SDP); err != nil {
			s.fail("signal_error", err)
		}
	}
}

func (s *fileTransferSession) acceptOffer(sid, offer string) error {
	pc, err := s.peerConnection()
	if err != nil {
		return err
	}
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() != fileChannelLabel {
			_ = dc.Close()
			return
		}
		s.attachDataChannel(dc)
	})
	s.mu.Lock()
	if s.closed || !s.prepared || s.role != "target" || s.pc != nil {
		s.mu.Unlock()
		_ = pc.Close()
		return errors.New("file answer is not allowed in this state")
	}
	if !s.reserveSIDLocked(sid) {
		s.mu.Unlock()
		_ = pc.Close()
		return errors.New("file signaling sid was already used")
	}
	s.sid, s.offer, s.pc = sid, offer, pc
	s.mu.Unlock()
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); err != nil {
		return err
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		return err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		return err
	}
	if err := waitFileGather(s.ctx, gathered); err != nil {
		return err
	}
	local := pc.LocalDescription()
	if local == nil || !validDirectSDP(local.SDP) {
		return errors.New("invalid or relayed file answer")
	}
	s.mu.Lock()
	s.answer = local.SDP
	s.mu.Unlock()
	return s.sendSignal("target", sid, fileSignal{Kind: "answer", Seq: 0, SDP: local.SDP})
}

func (s *fileTransferSession) reserveSIDLocked(sid string) bool {
	if !rtcSIDPattern.MatchString(sid) {
		return false
	}
	if s.usedSIDs == nil {
		s.usedSIDs = make(map[string]struct{})
	}
	if _, exists := s.usedSIDs[sid]; exists || len(s.usedSIDs) >= 64 {
		return false
	}
	s.usedSIDs[sid] = struct{}{}
	return true
}

func (s *fileTransferSession) acceptAnswer(sid, answer string) error {
	s.mu.Lock()
	if s.closed || s.role != "source" || s.sid != sid || s.pc == nil || s.offer == "" || s.answer != "" {
		s.mu.Unlock()
		return errors.New("file answer does not match the active offer")
	}
	pc := s.pc
	s.mu.Unlock()
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		return err
	}
	s.mu.Lock()
	s.answer = answer
	s.mu.Unlock()
	return nil
}

func (s *fileTransferSession) attachDataChannel(dc *webrtc.DataChannel) {
	s.mu.Lock()
	if s.dc != nil || s.closed {
		s.mu.Unlock()
		_ = dc.Close()
		return
	}
	s.dc = dc
	startReader := !s.readStarted
	s.readStarted = true
	s.mu.Unlock()
	dc.OnOpen(func() {
		s.mu.Lock()
		s.open = true
		s.mu.Unlock()
		s.maybeStart()
	})
	dc.OnMessage(func(message webrtc.DataChannelMessage) {
		limit := fileFrameHeaderBytes + fileChunkBytes
		if message.IsString {
			limit = fileControlMax
		}
		if len(message.Data) > limit {
			s.fail("invalid_frame", errors.New("file data channel message too large"))
			return
		}
		data := append([]byte(nil), message.Data...)
		s.mu.Lock()
		sid := s.sid
		s.mu.Unlock()
		select {
		case s.incoming <- fileIncoming{text: message.IsString, data: data, sid: sid}:
		case <-s.ctx.Done():
		default:
			s.fail("backpressure", errors.New("file receive window exceeded"))
		}
	})
	if startReader {
		go s.readIncoming()
	}
}

func (s *fileTransferSession) readIncoming() {
	for {
		select {
		case <-s.ctx.Done():
			return
		case message := <-s.incoming:
			for {
				s.mu.Lock()
				authorized := s.authorized && !s.closed
				currentSID := s.sid
				s.mu.Unlock()
				if authorized {
					if message.sid == "" || message.sid == currentSID {
						break
					}
					message.data = nil
					break
				}
				select {
				case <-s.ctx.Done():
					return
				case <-s.authWake:
				}
			}
			if message.data == nil {
				continue
			}
			var err error
			if message.text {
				err = s.handleFileControl(message.data)
			} else {
				err = s.handleFileData(message.data)
			}
			if err != nil {
				// Keep one reader for the lifetime of the transfer. A round may
				// interrupt and replace its DataChannel; returning here would leave
				// the resumed round with nobody consuming control or file frames.
				s.handleTransferError(err)
				continue
			}
		}
	}
}

func (a *Agent) handleFileTicket(env Envelope) {
	transferID, _ := env.Body["transfer_id"].(string)
	sid, _ := env.Body["sid"].(string)
	raw, ok := env.Body["statement"]
	if !ok || !rtcSIDPattern.MatchString(transferID) || !rtcSIDPattern.MatchString(sid) {
		return
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return
	}
	var signed signedFleetStatement
	if json.Unmarshal(b, &signed) != nil {
		return
	}
	a.mu.Lock()
	s := a.fileTransfers[transferID]
	token, kid, deviceID := a.hubToken, a.authKid, a.deviceID
	a.mu.Unlock()
	if s == nil {
		return
	}
	var statement fileTransferStatement
	if verifyFleetStatement(token, signed, &statement) != nil {
		s.fail("invalid_ticket", errors.New("file transfer ticket signature invalid"))
		return
	}
	if err := validateFileTransferStatement(s, statement, sid, kid, deviceID, time.Now().UnixMilli()); err != nil {
		s.fail("invalid_ticket", err)
		return
	}
	s.mu.Lock()
	if s.authorizing || s.authorized || s.closed {
		s.mu.Unlock()
		return
	}
	s.authorizing = true
	s.mu.Unlock()
	go s.authorize(statement)
}

func validateFileTransferStatement(s *fileTransferSession, st fileTransferStatement, sid, kid, deviceID string, now int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st.V != 1 || st.Kind != "file_transfer" || st.TransferID != s.transferID || st.SID != sid || st.SID != s.sid ||
		st.Kid != kid || st.OperatorID != s.operatorID || st.UserID != s.userID ||
		!validFileIdentity(st.UserID) || !validFileIdentity(st.OperatorID) || !validFileIdentity(st.Kid) {
		return errors.New("file transfer ticket identity mismatch")
	}
	if st.OffererKind != st.SourceKind || st.OffererID != st.SourceID ||
		st.AnswererKind != st.TargetKind || st.AnswererID != st.TargetID ||
		(st.SourceKind != "device" && st.SourceKind != "tool") ||
		(st.TargetKind != "device" && st.TargetKind != "tool") {
		return errors.New("file transfer ticket role mismatch")
	}
	if st.SourceKind == st.TargetKind && st.SourceID == st.TargetID {
		return errors.New("file transfer endpoints must be different")
	}
	if s.role == "source" {
		if st.SourceKind != "device" || st.SourceID != deviceID || st.TargetKind != s.peer.Kind || st.TargetID != s.peer.ID {
			return errors.New("source ticket endpoint mismatch")
		}
	} else if st.TargetKind != "device" || st.TargetID != deviceID || st.SourceKind != s.peer.Kind || st.SourceID != s.peer.ID {
		return errors.New("target ticket endpoint mismatch")
	}
	if st.FileName != s.manifest.Name || st.FileSize != s.manifest.Size ||
		st.FileSHA256 != s.manifest.SHA256 || st.ChunkSize != fileChunkBytes ||
		!validResume(s.manifest, st.ResumeOffset, st.PrefixSHA256) {
		return errors.New("file transfer ticket manifest mismatch")
	}
	if s.role == "target" && (st.ResumeOffset != s.resume || st.PrefixSHA256 != s.prefixHash) {
		return errors.New("file transfer ticket resume mismatch")
	}
	if st.OfferFP != rtcFingerprint(s.offer) || st.AnswerFP != rtcFingerprint(s.answer) || !st.DirectOnly {
		return errors.New("file transfer ticket transport mismatch")
	}
	if st.Iat <= 0 || st.Iat > now+30_000 || st.Exp <= st.Iat || st.Exp <= now || st.Exp-st.Iat > 60_000 {
		return errors.New("file transfer ticket expired")
	}
	return nil
}

func (s *fileTransferSession) authorize(statement fileTransferStatement) {
	if s.role == "source" {
		prefix, err := s.sourcePrefix(statement.ResumeOffset)
		if err != nil || !strings.EqualFold(prefix, statement.PrefixSHA256) {
			if err == nil {
				err = errors.New("source prefix does not match receiver resume state")
			}
			s.fail("resume_mismatch", err)
			return
		}
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	statement.PrefixSHA256 = strings.ToLower(statement.PrefixSHA256)
	s.ticket = &statement
	s.resume = statement.ResumeOffset
	s.prefixHash = statement.PrefixSHA256
	s.sentOffset = statement.ResumeOffset
	s.ackOffset = statement.ResumeOffset
	s.authorized = true
	s.authorizing = false
	s.mu.Unlock()
	select {
	case s.authWake <- struct{}{}:
	default:
	}
	s.maybeStart()
}

func (s *fileTransferSession) sourcePrefix(offset int64) (string, error) {
	s.pluginMu.Lock()
	defer s.pluginMu.Unlock()
	s.mu.Lock()
	plugin := s.plugin
	s.mu.Unlock()
	if plugin == nil {
		return "", errors.New("source plugin unavailable")
	}
	if err := plugin.WriteJSON(map[string]any{"v": 1, "type": "prefix", "offset": offset}); err != nil {
		return "", err
	}
	var reply struct {
		V      int    `json:"v"`
		Type   string `json:"type"`
		Offset int64  `json:"offset"`
		SHA256 string `json:"sha256"`
	}
	if err := plugin.ReadJSON(&reply); err != nil {
		return "", err
	}
	if reply.V != 1 || reply.Type != "prefix" || reply.Offset != offset || !isSHA256(reply.SHA256) {
		return "", errors.New("source plugin returned invalid prefix")
	}
	return strings.ToLower(reply.SHA256), nil
}

func (s *fileTransferSession) maybeStart() {
	s.mu.Lock()
	if s.closed || !s.authorized || !s.open || s.readySent || s.role != "target" {
		s.mu.Unlock()
		return
	}
	s.readySent = true
	offset, prefix := s.resume, s.prefixHash
	s.mu.Unlock()
	if err := s.sendDCText("file_ready", fileDCControlBody{Offset: offset, PrefixSHA256: prefix}); err != nil {
		s.fail("direct_connection_failed", err)
	}
}

// fleet-file-v1 control messages deliberately reuse the same v1 Envelope as
// every other Fleet control plane. The dedicated DataChannel carries binary
// file frames alongside these JSON envelopes; it does not get a second,
// almost-the-same wire format.
type fileDCControl struct {
	V    int               `json:"v"`
	Type string            `json:"type"`
	ID   string            `json:"id"`
	T    int64             `json:"t"`
	Body fileDCControlBody `json:"body"`
}

type fileDCControlBody struct {
	TransferID   string `json:"transfer_id"`
	Offset       int64  `json:"offset,omitempty"`
	Committed    int64  `json:"committed,omitempty"`
	PrefixSHA256 string `json:"prefix_sha256,omitempty"`
	Size         int64  `json:"size,omitempty"`
	SHA256       string `json:"sha256,omitempty"`
	Code         string `json:"code,omitempty"`
	Error        string `json:"error,omitempty"`
}

func newFileDCControl(kind, transferID string, body fileDCControlBody) fileDCControl {
	body.TransferID = transferID
	return fileDCControl{
		V: 1, Type: kind, ID: newFileMessageID(), T: time.Now().UnixMilli(), Body: body,
	}
}

func (s *fileTransferSession) sendDCText(kind string, body fileDCControlBody) error {
	value := newFileDCControl(kind, s.transferID, body)
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(payload) > fileControlMax {
		return errors.New("file control message too large")
	}
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	s.mu.Lock()
	dc := s.dc
	ready := s.authorized && s.open && !s.closed
	s.mu.Unlock()
	if !ready || dc == nil {
		return fmt.Errorf("%w: channel unavailable", errFileDirect)
	}
	if err := dc.SendText(string(payload)); err != nil {
		return fmt.Errorf("%w: %v", errFileDirect, err)
	}
	return nil
}

func (s *fileTransferSession) handleFileControl(raw []byte) error {
	var control fileDCControl
	if json.Unmarshal(raw, &control) != nil || control.V != 1 || control.ID == "" || control.T <= 0 || control.Body.TransferID != s.transferID {
		return errors.New("invalid file control message")
	}
	s.mu.Lock()
	role := s.role
	s.mu.Unlock()
	switch control.Type {
	case "file_ready":
		if role != "source" {
			return errors.New("unexpected file_ready")
		}
		s.mu.Lock()
		if s.ticket == nil || control.Body.Offset != s.resume || !strings.EqualFold(control.Body.PrefixSHA256, s.prefixHash) || s.started {
			s.mu.Unlock()
			return errors.New("receiver resume state mismatch")
		}
		s.started = true
		s.mu.Unlock()
		s.sendEvent("start", "")
		go func() {
			if err := s.sourcePump(); err != nil {
				s.handleTransferError(err)
			}
		}()
		return nil
	case "file_ack":
		if role != "source" {
			return errors.New("unexpected file_ack")
		}
		return s.noteFileAck(control.Body.Committed)
	case "file_eof":
		if role != "target" {
			return errors.New("unexpected file_eof")
		}
		return s.commitTarget(control.Body)
	case "file_complete":
		if role != "source" {
			return errors.New("unexpected file_complete")
		}
		return s.completeSource(control.Body)
	case "file_complete_ack":
		if role != "target" {
			return errors.New("unexpected file_complete_ack")
		}
		if err := s.validateCompletion(control.Body); err != nil {
			return err
		}
		s.markComplete()
		return nil
	case "file_cancel":
		s.sendEvent("cancel", control.Body.Code)
		s.agent.mu.Lock()
		if s.agent.fileTransfers[s.transferID] == s {
			delete(s.agent.fileTransfers, s.transferID)
		}
		s.agent.mu.Unlock()
		go s.cancelTransfer()
		return nil
	case "file_error":
		return fmt.Errorf("peer rejected transfer: %s: %s", control.Body.Code, control.Body.Error)
	default:
		return errors.New("unknown file control message")
	}
}

func (s *fileTransferSession) handleFileData(raw []byte) error {
	s.mu.Lock()
	role := s.role
	s.mu.Unlock()
	if role != "target" {
		return errors.New("source received an unexpected binary frame")
	}
	frame, err := decodeFileFrame(raw)
	if err != nil {
		return err
	}
	return s.writeTargetFrame(frame)
}

func (s *fileTransferSession) sourcePump() error {
	s.mu.Lock()
	plugin, dc, manifest := s.plugin, s.dc, s.manifest
	offset := s.resume
	roundCtx := s.roundCtx
	s.mu.Unlock()
	if roundCtx == nil {
		roundCtx = s.ctx
	}
	if plugin == nil || dc == nil {
		return errors.New("source transfer is not prepared")
	}
	for offset < manifest.Size {
		if err := s.waitAckWindow(roundCtx, offset); err != nil {
			return err
		}
		length := fileChunkBytes
		if left := manifest.Size - offset; left < int64(length) {
			length = int(left)
		}
		s.pluginMu.Lock()
		if err := plugin.WriteJSON(map[string]any{"v": 1, "type": "read", "offset": offset, "length": length}); err != nil {
			s.pluginMu.Unlock()
			return err
		}
		var header struct {
			V      int    `json:"v"`
			Type   string `json:"type"`
			Offset int64  `json:"offset"`
			Length int    `json:"length"`
			SHA256 string `json:"sha256"`
		}
		if err := plugin.ReadJSON(&header); err != nil {
			s.pluginMu.Unlock()
			return err
		}
		if header.V != 1 || header.Type != "chunk" || header.Offset != offset || header.Length != length || !isSHA256(header.SHA256) {
			s.pluginMu.Unlock()
			return errors.New("source plugin returned an invalid chunk header")
		}
		payload := make([]byte, length)
		if err := plugin.ReadRaw(payload); err != nil {
			s.pluginMu.Unlock()
			return err
		}
		s.pluginMu.Unlock()
		sum := sha256.Sum256(payload)
		if !strings.EqualFold(hex.EncodeToString(sum[:]), header.SHA256) {
			return errors.New("source plugin chunk hash mismatch")
		}
		frame, err := encodeFileFrame(uint64(offset), payload)
		if err != nil {
			return err
		}
		select {
		case <-roundCtx.Done():
			return fmt.Errorf("%w: %v", errFileDirect, roundCtx.Err())
		default:
		}
		if err := s.waitDataChannelBuffer(roundCtx, uint64(len(frame))); err != nil {
			return err
		}
		offset += int64(length)
		s.mu.Lock()
		s.sentOffset = offset
		s.mu.Unlock()
		s.sendMu.Lock()
		err = dc.Send(frame)
		s.sendMu.Unlock()
		if err != nil {
			return fmt.Errorf("%w: %v", errFileDirect, err)
		}
	}
	if err := s.waitForAck(roundCtx, manifest.Size); err != nil {
		return err
	}
	return s.sendDCText("file_eof", fileDCControlBody{Size: manifest.Size, SHA256: manifest.SHA256})
}

func (s *fileTransferSession) waitAckWindow(ctx context.Context, next int64) error {
	for {
		s.mu.Lock()
		ack := s.ackOffset
		s.mu.Unlock()
		if next-ack < fileAckBytes {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("%w: %v", errFileDirect, ctx.Err())
		case <-s.ackWake:
		}
	}
}

func (s *fileTransferSession) waitForAck(ctx context.Context, want int64) error {
	for {
		s.mu.Lock()
		ack := s.ackOffset
		s.mu.Unlock()
		if ack == want {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("%w: %v", errFileDirect, ctx.Err())
		case <-s.ackWake:
		}
	}
}

func (s *fileTransferSession) noteFileAck(offset int64) error {
	s.mu.Lock()
	if offset < s.ackOffset || offset > s.sentOffset {
		s.mu.Unlock()
		return errors.New("invalid file acknowledgement")
	}
	s.ackOffset = offset
	s.mu.Unlock()
	select {
	case s.ackWake <- struct{}{}:
	default:
	}
	return nil
}

func (s *fileTransferSession) waitDataChannelBuffer(ctx context.Context, add uint64) error {
	for {
		s.mu.Lock()
		dc := s.dc
		closed := s.closed
		s.mu.Unlock()
		if closed || dc == nil {
			return fmt.Errorf("%w: channel closed", errFileDirect)
		}
		if dc.BufferedAmount()+add <= fileBufferHighWater {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("%w: %v", errFileDirect, ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func (s *fileTransferSession) writeTargetFrame(frame fileFrame) error {
	s.pluginMu.Lock()
	defer s.pluginMu.Unlock()
	s.mu.Lock()
	plugin, manifest, expected := s.plugin, s.manifest, s.expectedOffset
	s.mu.Unlock()
	if plugin == nil || int64(frame.Offset) != expected || len(frame.Payload) == 0 {
		return errors.New("file frame offset mismatch")
	}
	s.mu.Lock()
	s.started = true
	s.mu.Unlock()
	next := expected + int64(len(frame.Payload))
	if next > manifest.Size || (next < manifest.Size && len(frame.Payload) != fileChunkBytes) {
		return errors.New("file frame length mismatch")
	}
	sum := sha256.Sum256(frame.Payload)
	hash := hex.EncodeToString(sum[:])
	if err := plugin.WriteJSON(map[string]any{
		"v": 1, "type": "chunk", "offset": expected, "length": len(frame.Payload), "sha256": hash,
	}); err != nil {
		return err
	}
	if err := plugin.WriteRaw(frame.Payload); err != nil {
		return err
	}
	var ack struct {
		V      int    `json:"v"`
		Type   string `json:"type"`
		Offset int64  `json:"offset"`
	}
	if err := plugin.ReadJSON(&ack); err != nil {
		return err
	}
	if ack.V != 1 || ack.Type != "ack" || ack.Offset != next {
		return errors.New("target plugin returned an invalid acknowledgement")
	}
	s.mu.Lock()
	s.expectedOffset = next
	lastAck := s.lastAck
	if next-lastAck >= fileAckBytes || next == manifest.Size {
		s.lastAck = next
		lastAck = -1
	}
	s.mu.Unlock()
	if lastAck == -1 {
		return s.sendDCText("file_ack", fileDCControlBody{Committed: next})
	}
	return nil
}

func (s *fileTransferSession) commitTarget(control fileDCControlBody) error {
	s.pluginMu.Lock()
	defer s.pluginMu.Unlock()
	s.mu.Lock()
	plugin, manifest, expected := s.plugin, s.manifest, s.expectedOffset
	s.mu.Unlock()
	if plugin == nil || expected != manifest.Size || control.Size != manifest.Size || !strings.EqualFold(control.SHA256, manifest.SHA256) {
		return errors.New("file eof does not match manifest")
	}
	if err := plugin.WriteJSON(map[string]any{"v": 1, "type": "commit"}); err != nil {
		return err
	}
	var complete struct {
		V    int    `json:"v"`
		Type string `json:"type"`
		Path string `json:"path"`
	}
	if err := plugin.ReadJSON(&complete); err != nil {
		return err
	}
	if complete.V != 1 || complete.Type != "complete" || complete.Path == "" {
		return errors.New("target plugin did not commit the file")
	}
	if err := plugin.Wait(); err != nil {
		return err
	}
	s.mu.Lock()
	s.plugin = nil
	s.committed = true
	s.mu.Unlock()
	if err := s.sendDCText("file_complete", fileDCControlBody{Size: manifest.Size, SHA256: manifest.SHA256}); err != nil {
		s.completeTarget()
		return nil
	}
	go func() {
		select {
		case <-s.ctx.Done():
		case <-time.After(5 * time.Second):
			s.completeTarget()
		}
	}()
	return nil
}

func (s *fileTransferSession) completeSource(control fileDCControlBody) error {
	s.pluginMu.Lock()
	defer s.pluginMu.Unlock()
	s.mu.Lock()
	plugin, manifest := s.plugin, s.manifest
	s.mu.Unlock()
	if control.Size != manifest.Size || !strings.EqualFold(control.SHA256, manifest.SHA256) {
		return errors.New("file completion does not match manifest")
	}
	if plugin == nil {
		return errors.New("source plugin unavailable at completion")
	}
	if err := plugin.Finish(); err != nil {
		return err
	}
	s.mu.Lock()
	s.plugin = nil
	s.completed = true
	s.mu.Unlock()
	if err := s.sendDCText("file_complete_ack", fileDCControlBody{Size: manifest.Size, SHA256: manifest.SHA256}); err != nil {
		return err
	}
	go func() {
		select {
		case <-s.ctx.Done():
		case <-time.After(100 * time.Millisecond):
			s.agent.dropFileTransfer(s.transferID, s)
		}
	}()
	return nil
}

func (s *fileTransferSession) validateCompletion(control fileDCControlBody) error {
	s.mu.Lock()
	manifest := s.manifest
	s.mu.Unlock()
	if control.Size != manifest.Size || !strings.EqualFold(control.SHA256, manifest.SHA256) {
		return errors.New("file completion acknowledgement does not match manifest")
	}
	return nil
}

func (s *fileTransferSession) markComplete() {
	s.completeTarget()
}

func (s *fileTransferSession) completeTarget() {
	s.mu.Lock()
	if s.completed {
		s.mu.Unlock()
		return
	}
	s.completed = true
	s.mu.Unlock()
	s.sendEvent("complete", "")
	s.agent.dropFileTransfer(s.transferID, s)
}

func (s *fileTransferSession) handleTransferError(err error) {
	s.mu.Lock()
	interrupted := s.interrupted || s.interruptRequested
	started := s.started
	s.mu.Unlock()
	if interrupted || errors.Is(err, context.Canceled) {
		return
	}
	if started && errors.Is(err, errFileDirect) {
		s.requestInterrupt(err)
		return
	}
	s.fail("TRANSFER_ERROR", err)
}

func (s *fileTransferSession) requestInterrupt(err error) {
	s.mu.Lock()
	if s.closed || s.completed || s.interrupted || s.interruptRequested || !s.started {
		s.mu.Unlock()
		return
	}
	s.interruptRequested = true
	s.mu.Unlock()
	if err != nil {
		s.agent.mu.Lock()
		s.agent.log("warn", "file transfer interrupted "+s.transferID+": "+err.Error())
		s.agent.mu.Unlock()
	}
	s.sendEvent("interrupt", "")
	s.interruptRound()
}

func (s *fileTransferSession) fail(code string, err error) {
	s.mu.Lock()
	committed := s.committed
	if s.closed || s.completed || s.interruptRequested {
		s.mu.Unlock()
		return
	}
	if committed {
		s.mu.Unlock()
		s.completeTarget()
		return
	}
	s.completed = true
	s.mu.Unlock()
	if err != nil {
		s.agent.mu.Lock()
		s.agent.log("warn", "file transfer "+s.transferID+": "+err.Error())
		s.agent.mu.Unlock()
	}
	s.sendEvent("fail", code)
	s.agent.dropFileTransfer(s.transferID, s)
}

func (s *fileTransferSession) close() {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		cancel, pc, plugin := s.cancel, s.pc, s.plugin
		s.cancel, s.pc, s.plugin = nil, nil, nil
		s.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		if pc != nil {
			_ = pc.Close()
		}
		if plugin != nil {
			plugin.Abort()
		}
	})
}

// cancelTransfer differs from an interrupt: cancellation is terminal and the
// target plugin must delete its private .part and sidecar. If an interrupted
// target no longer has a live plugin process, reopen the exact persisted
// transfer binding and issue the explicit cancel control.
func (s *fileTransferSession) cancelTransfer() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.completed = true
	role, plugin, pc := s.role, s.plugin, s.pc
	s.plugin, s.pc, s.dc = nil, nil, nil
	s.mu.Unlock()
	if pc != nil {
		_ = pc.Close()
	}
	s.pluginMu.Lock()
	if role == "target" {
		cleaned := false
		if plugin != nil {
			cleaned = plugin.Cancel() == nil
		}
		if !cleaned {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			opened, err := openFileTransferPlugin(ctx, "prepare_target", s.targetPluginInput())
			if err == nil {
				var ready struct {
					V    int    `json:"v"`
					Type string `json:"type"`
				}
				if opened.ReadJSON(&ready) == nil && ready.V == 1 && ready.Type == "ready" {
					_ = opened.Cancel()
				} else {
					opened.Abort()
				}
			}
			cancel()
		}
	} else if plugin != nil {
		_ = plugin.Cancel()
	}
	s.pluginMu.Unlock()
	s.close()
}

func (a *Agent) dropFileTransfer(transferID string, expected *fileTransferSession) {
	a.mu.Lock()
	current := a.fileTransfers[transferID]
	if current == expected {
		delete(a.fileTransfers, transferID)
	}
	a.mu.Unlock()
	if current == expected {
		expected.close()
	}
}

func (a *Agent) takeFileTransfersLocked() []*fileTransferSession {
	out := make([]*fileTransferSession, 0, len(a.fileTransfers))
	for _, s := range a.fileTransfers {
		out = append(out, s)
	}
	a.fileTransfers = nil
	if a.pending != nil && a.pending.File != nil {
		a.pending = nil
	}
	return out
}

func closeFileTransfers(sessions []*fileTransferSession) {
	for _, s := range sessions {
		s.close()
	}
}

func cancelFileTransfers(sessions []*fileTransferSession, code string) {
	for _, s := range sessions {
		s.sendEvent("cancel", code)
		s.cancelTransfer()
	}
}

func (a *Agent) handleFileUpdate(env Envelope) {
	transferID, _ := env.Body["transfer_id"].(string)
	phase, _ := env.Body["phase"].(string)
	if phase == "" {
		if transfer, ok := env.Body["transfer"].(map[string]any); ok {
			phase, _ = transfer["phase"].(string)
		}
	}
	if !rtcSIDPattern.MatchString(transferID) {
		return
	}
	a.mu.Lock()
	s := a.fileTransfers[transferID]
	a.mu.Unlock()
	if s == nil {
		return
	}
	switch phase {
	case "signaling":
		s.beginOffer()
	case "interrupted":
		s.interruptRound()
		s.mu.Lock()
		target := s.role == "target" && s.interrupted && !s.closed
		s.mu.Unlock()
		if target {
			a.queueInterruptedTargetApproval(s)
		}
	case "cancelled", "canceled", "failed", "expired":
		a.mu.Lock()
		if a.fileTransfers[transferID] == s {
			delete(a.fileTransfers, transferID)
		}
		a.mu.Unlock()
		s.mu.Lock()
		s.completed = true
		s.mu.Unlock()
		go s.cancelTransfer()
	case "completed":
		a.dropFileTransfer(transferID, s)
	default:
		if ok, present := env.Body["ok"].(bool); present && !ok {
			s.mu.Lock()
			interrupted := s.interrupted || s.interruptRequested
			s.mu.Unlock()
			if !interrupted {
				s.fail("CONTROL_ERROR", errors.New("file transfer control request failed"))
			}
		}
	}
}

func (a *Agent) queueInterruptedTargetApproval(s *fileTransferSession) {
	a.mu.Lock()
	if a.fileTransfers[s.transferID] != s || a.pending != nil {
		busy := a.pending != nil
		a.mu.Unlock()
		if busy {
			s.fail("CONSENT_BUSY", errors.New("another command is waiting for local consent"))
		}
		return
	}
	label := a.queueFileApprovalLocked(s, "", s.sink)
	a.mu.Unlock()
	notifyConsent(label)
	a.pushUI()
}

// interruptRound tears down only the direct transport. The source descriptor
// remains open, while the target process is aborted after every acknowledged
// chunk has already fsynced its .part and sidecar. The next target prepare
// recomputes that persisted resume prefix and asks for local approval again.
func (s *fileTransferSession) interruptRound() {
	s.mu.Lock()
	if s.closed || s.completed || s.interrupted {
		s.mu.Unlock()
		return
	}
	pc := s.pc
	plugin := filePluginIO(nil)
	if s.role == "target" {
		plugin = s.plugin
		s.plugin = nil
		s.approved = false
		s.prepared = false
		s.resume = 0
		s.prefixHash = ""
		s.expectedOffset = 0
		s.lastAck = 0
	}
	if s.roundCancel != nil {
		s.roundCancel()
	}
	s.roundCtx, s.roundCancel = context.WithCancel(s.ctx)
	s.pc = nil
	s.dc = nil
	s.sid = ""
	s.offer = ""
	s.answer = ""
	s.queuedSID = ""
	s.queuedOffer = ""
	s.ticket = nil
	s.authorizing = false
	s.authorized = false
	s.open = false
	s.readySent = false
	s.started = false
	s.offering = false
	s.committed = false
	s.sentOffset = 0
	s.ackOffset = 0
	s.interrupted = true
	s.interruptRequested = false
	s.mu.Unlock()
	if pc != nil {
		_ = pc.Close()
	}
	if plugin != nil {
		s.pluginMu.Lock()
		plugin.Abort()
		s.pluginMu.Unlock()
	}
}
