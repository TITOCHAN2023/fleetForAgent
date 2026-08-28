package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/pion/webrtc/v4"
)

const (
	pendingKindPluginPeer   = "plugin_peer"
	pluginPeerSessionMax    = 2
	pluginPeerSignalMax     = 128 << 10
	pluginPeerInboxMax      = 128
	pluginPeerInboxBytesMax = 2 << 20
	pluginPeerGatherWait    = 10 * time.Second
	pluginPeerSendWindow    = 4 << 20
	pluginPeerNonceBytes    = 32
	pluginPeerHalfCloseWait = 30 * time.Second
)

var (
	errPluginPeerDirect     = errors.New("direct plugin peer transport failed")
	pluginPeerHashRE        = regexp.MustCompile(`^[0-9a-f]{64}$`)
	pluginPeerFailureCodeRE = regexp.MustCompile(`^[A-Z0-9_]{1,64}$`)
	pluginPeerRelayRE       = regexp.MustCompile(`(?m)(?:^|\s)typ\s+relay(?:\s|$)`)
	pluginPeerDeliveryRE    = regexp.MustCompile(`^ps:[a-zA-Z0-9:._@-]{1,384}$`)
	pluginPeerFingerprintRE = regexp.MustCompile(`(?im)^a=fingerprint:sha-256\s+([^\r\n]+)\r?$`)
)

type pluginPeerEndpoint struct {
	Kind          string `json:"kind"`
	ID            string `json:"id"`
	Name          string `json:"name,omitempty"`
	PluginID      string `json:"plugin_id"`
	PluginVersion string `json:"plugin_version"`
	Action        string `json:"action"`
	Role          string `json:"role"`
}

type pluginPeerProtocolRef struct {
	ID        string `json:"id"`
	ABI       string `json:"abi"`
	Transport string `json:"transport"`
	Approval  string `json:"approval"`
}

type pluginPeerPrepareRequest struct {
	SessionID  string                `json:"session_id"`
	RoundID    string                `json:"round_id"`
	Side       string                `json:"side"`
	SignalRole string                `json:"signal_role"`
	Protocol   pluginPeerProtocolRef `json:"protocol"`
	Input      json.RawMessage       `json:"input"`
	OperatorID string                `json:"operator_id"`
	UserID     string                `json:"user_id"`
	Peer       pluginPeerEndpoint    `json:"peer"`
	STUNURLs   []string              `json:"stun_urls,omitempty"`
	Plugin     struct {
		ID      string `json:"id"`
		Version string `json:"version"`
		Action  string `json:"action"`
		Role    string `json:"role"`
	} `json:"plugin"`
}

type pluginPeerSignal struct {
	Kind string `json:"kind"`
	Seq  int    `json:"seq"`
	SDP  string `json:"sdp"`
}

type pluginPeerSignalEnvelope struct {
	SessionID string           `json:"session_id"`
	RoundID   string           `json:"round_id"`
	From      string           `json:"from"`
	Signal    pluginPeerSignal `json:"signal"`
}

type pluginPeerStatement struct {
	V                        int    `json:"v"`
	Kind                     string `json:"kind"`
	SessionID                string `json:"session_id"`
	RoundID                  string `json:"round_id"`
	UserID                   string `json:"user_id"`
	Kid                      string `json:"kid"`
	OperatorID               string `json:"operator_id"`
	Protocol                 string `json:"protocol"`
	ABI                      string `json:"abi"`
	Transport                string `json:"transport"`
	Approval                 string `json:"approval"`
	CapabilityDigest         string `json:"capability_digest"`
	SourceKind               string `json:"source_kind"`
	SourceID                 string `json:"source_id"`
	SourcePluginID           string `json:"source_plugin_id"`
	SourcePluginVersion      string `json:"source_plugin_version"`
	SourceAction             string `json:"source_action"`
	SourceRole               string `json:"source_role"`
	TargetKind               string `json:"target_kind"`
	TargetID                 string `json:"target_id"`
	TargetPluginID           string `json:"target_plugin_id"`
	TargetPluginVersion      string `json:"target_plugin_version"`
	TargetAction             string `json:"target_action"`
	TargetRole               string `json:"target_role"`
	InitiatorKind            string `json:"initiator_kind"`
	InitiatorID              string `json:"initiator_id"`
	ResponderKind            string `json:"responder_kind"`
	ResponderID              string `json:"responder_id"`
	SourceSessionBindingHash string `json:"source_session_binding_hash"`
	SourceRoundBindingHash   string `json:"source_round_binding_hash"`
	TargetSessionBindingHash string `json:"target_session_binding_hash"`
	TargetRoundBindingHash   string `json:"target_round_binding_hash"`
	OfferFP                  string `json:"offer_fp"`
	AnswerFP                 string `json:"answer_fp"`
	DirectOnly               bool   `json:"direct_only"`
	Iat                      int64  `json:"iat"`
	Exp                      int64  `json:"exp"`
}

type pluginPeerPendingApproval struct {
	session *pluginPeerSession
	approve func()
	deny    func(error)
}

type pluginPeerDataChannel interface {
	Send([]byte) error
	SendText(string) error
	BufferedAmount() uint64
	ReadyState() webrtc.DataChannelState
}

type pluginPeerIncoming struct {
	text bool
	data []byte
}

// The epoch is the authority token for a protocol round. Every plugin reader,
// timer and RTC callback captures this pointer. Pointer identity, never a
// mutable round field, decides whether asynchronous work may mutate a session.
type pluginPeerEpoch struct {
	generation    uint64
	roundID       string
	nonce         string
	ctx           context.Context
	cancel        context.CancelFunc
	plugin        pluginPeerIO
	ready         bool
	authorized    bool
	signaling     bool
	interrupted   bool
	queuedOffer   string
	round         *pluginPeerRound
	pendingData   [][]byte
	pendingBytes  int
	flushing      bool
	localComplete bool
}

type pluginPeerRound struct {
	epoch      *pluginPeerEpoch
	ctx        context.Context
	cancel     context.CancelFunc
	pc         *webrtc.PeerConnection
	dc         pluginPeerDataChannel
	inbox      chan pluginPeerIncoming
	inboxBytes int
	offer      string
	answer     string

	ticketVerified            bool
	open                      bool
	bindingSent               bool
	peerBindingOK             bool
	readySent                 bool
	remoteReady               bool
	dataOpen                  bool
	activeSent                bool
	started                   bool
	interruptSent             bool
	peerSessionHash           string
	peerRoundHash             string
	pendingPeerSessionBinding string
	pendingPeerRoundBinding   string
	localDoneSent             bool
	localDoneDraining         bool
	remoteDone                bool
	halfCloseWatch            bool
	completeSent              bool
	completeAck               bool
}

type pluginPeerSession struct {
	mu        sync.Mutex
	sendMu    sync.Mutex
	closeOnce sync.Once

	agent         *Agent
	ctx           context.Context
	cancel        context.CancelFunc
	sink          EnvelopeSink
	sessionID     string
	sessionNonce  string
	role          string
	signalRole    string
	protocol      string
	pluginID      string
	pluginVer     string
	action        string
	input         json.RawMessage
	operatorID    string
	userID        string
	peer          pluginPeerEndpoint
	stunURLs      []string
	abi           string
	transport     string
	approval      string
	halfCloseWait time.Duration

	approved       bool
	closed         bool
	completed      bool
	nextGeneration uint64
	roundNo        int
	epoch          *pluginPeerEpoch
	usedRounds     map[string]int
}

var openPluginPeer = startPluginPeerProcess
var resolveInstalledPluginPeerAction = installedPluginForPeerAction

func decodePluginPeerPrepare(body map[string]any) (pluginPeerPrepareRequest, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return pluginPeerPrepareRequest{}, err
	}
	var req pluginPeerPrepareRequest
	if err := json.Unmarshal(b, &req); err != nil {
		return req, err
	}
	req.SessionID = strings.TrimSpace(req.SessionID)
	req.RoundID = strings.TrimSpace(req.RoundID)
	req.Side = strings.TrimSpace(req.Side)
	req.SignalRole = strings.TrimSpace(req.SignalRole)
	req.Protocol.ID = strings.TrimSpace(req.Protocol.ID)
	req.Protocol.ABI = strings.TrimSpace(req.Protocol.ABI)
	req.Protocol.Transport = strings.TrimSpace(req.Protocol.Transport)
	req.Protocol.Approval = strings.TrimSpace(req.Protocol.Approval)
	req.Plugin.ID = strings.TrimSpace(req.Plugin.ID)
	req.Plugin.Version = strings.TrimSpace(req.Plugin.Version)
	req.Plugin.Action = strings.TrimSpace(req.Plugin.Action)
	req.Plugin.Role = strings.TrimSpace(req.Plugin.Role)
	req.OperatorID = strings.TrimSpace(req.OperatorID)
	req.UserID = strings.TrimSpace(req.UserID)
	req.Peer.Kind = strings.TrimSpace(req.Peer.Kind)
	req.Peer.ID = strings.TrimSpace(req.Peer.ID)
	req.Peer.Name = strings.TrimSpace(req.Peer.Name)
	req.Peer.PluginID = strings.TrimSpace(req.Peer.PluginID)
	req.Peer.PluginVersion = strings.TrimSpace(req.Peer.PluginVersion)
	req.Peer.Action = strings.TrimSpace(req.Peer.Action)
	req.Peer.Role = strings.TrimSpace(req.Peer.Role)
	if !rtcSIDPattern.MatchString(req.SessionID) || !rtcSIDPattern.MatchString(req.RoundID) ||
		(req.Side != "source" && req.Side != "target") ||
		(req.SignalRole != "initiator" && req.SignalRole != "responder") {
		return req, errors.New("invalid plugin peer session identity")
	}
	if protocolID, protocolErr := cleanPluginID(req.Protocol.ID); protocolErr != nil || protocolID != req.Protocol.ID ||
		req.Protocol.ABI != pluginPeerABI ||
		req.Protocol.Transport != "direct_ordered" || req.Protocol.Approval != "both_once" ||
		!validPluginPeerIdentity(req.OperatorID) || !validPluginPeerIdentity(req.UserID) {
		return req, errors.New("invalid plugin peer protocol identity")
	}
	if _, err := cleanPluginID(req.Plugin.ID); err != nil {
		return req, err
	}
	if _, err := cleanPluginVersion(req.Plugin.Version); err != nil {
		return req, err
	}
	if _, err := cleanPluginAction(req.Plugin.Action); err != nil {
		return req, err
	}
	if req.Plugin.Role != req.Side {
		return req, errors.New("plugin peer role does not match side")
	}
	if !validPluginPeerEndpoint(req.Peer) || req.Peer.Role == req.Side {
		return req, errors.New("invalid plugin peer endpoint")
	}
	if len(req.Input) == 0 {
		req.Input = json.RawMessage(`{}`)
	}
	if len(req.Input) > 8<<10 || !json.Valid(req.Input) {
		return req, errors.New("invalid plugin peer input")
	}
	if req.STUNURLs, err = cleanPluginPeerSTUN(req.STUNURLs); err != nil {
		return req, err
	}
	return req, nil
}

func validPluginPeerIdentity(value string) bool { return value != "" && len(value) <= 128 }

func validPluginPeerEndpoint(value pluginPeerEndpoint) bool {
	if (value.Kind != "device" && value.Kind != "tool") || !validPluginPeerIdentity(value.ID) || len(value.Name) > 256 {
		return false
	}
	if _, err := cleanPluginID(value.PluginID); err != nil {
		return false
	}
	if _, err := cleanPluginAction(value.Action); err != nil {
		return false
	}
	if _, err := cleanPluginVersion(value.PluginVersion); err != nil {
		return false
	}
	return value.Role == "source" || value.Role == "target"
}

func cleanPluginPeerSTUN(values []string) ([]string, error) {
	if len(values) > 4 {
		return nil, errors.New("too many plugin peer STUN URLs")
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		scheme, target, ok := strings.Cut(value, ":")
		if !ok || target == "" || len(value) > 512 || strings.IndexFunc(target, unicode.IsSpace) >= 0 ||
			(!strings.EqualFold(scheme, "stun") && !strings.EqualFold(scheme, "stuns")) {
			return nil, errors.New("invalid plugin peer STUN URL")
		}
		// Pion's URI parser accepts stun/stuns but treats the scheme as
		// case-sensitive. Normalize only the scheme; the authority is opaque.
		out = append(out, strings.ToLower(scheme)+":"+target)
	}
	return out, nil
}

func newPluginPeerNonce() (string, error) {
	raw := make([]byte, pluginPeerNonceBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func validPluginPeerNonce(value string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == pluginPeerNonceBytes
}

func pluginPeerBindingHash(value string) string {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) > 8<<10 {
		return ""
	}
	digest := sha256.Sum256(decoded)
	return hex.EncodeToString(digest[:])
}

func canonicalPluginPeerFingerprint(sdp string) string {
	matches := pluginPeerFingerprintRE.FindAllStringSubmatch(sdp, -1)
	if len(matches) != 1 {
		return ""
	}
	value := strings.ToUpper(strings.TrimSpace(matches[0][1]))
	parts := strings.Split(value, ":")
	if len(parts) != 32 {
		return ""
	}
	for _, part := range parts {
		if len(part) != 2 {
			return ""
		}
		if _, err := hex.DecodeString(part); err != nil {
			return ""
		}
	}
	return strings.ToLower(strings.Join(parts, ""))
}

type pluginPeerCapabilityEndpoint struct {
	PluginID      string `json:"plugin_id"`
	PluginVersion string `json:"plugin_version"`
	Action        string `json:"action"`
	Role          string `json:"role"`
}

type pluginPeerCapability struct {
	Protocol pluginPeerProtocolRef        `json:"protocol"`
	Source   pluginPeerCapabilityEndpoint `json:"source"`
	Target   pluginPeerCapabilityEndpoint `json:"target"`
}

func pluginPeerCapabilityDigest(s *pluginPeerSession) string {
	local := pluginPeerCapabilityEndpoint{PluginID: s.pluginID, PluginVersion: s.pluginVer, Action: s.action, Role: s.role}
	peer := pluginPeerCapabilityEndpoint{PluginID: s.peer.PluginID, PluginVersion: s.peer.PluginVersion, Action: s.peer.Action, Role: s.peer.Role}
	value := pluginPeerCapability{
		Protocol: pluginPeerProtocolRef{ID: s.protocol, ABI: s.abi, Transport: s.transport, Approval: s.approval},
	}
	if s.role == "source" {
		value.Source, value.Target = local, peer
	} else {
		value.Source, value.Target = peer, local
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func newPluginPeerSession(a *Agent, ctx context.Context, sink EnvelopeSink, req pluginPeerPrepareRequest) (*pluginPeerSession, error) {
	nonce, err := newPluginPeerNonce()
	if err != nil {
		return nil, err
	}
	sessionCtx, cancel := context.WithCancel(ctx)
	return &pluginPeerSession{
		agent: a, ctx: sessionCtx, cancel: cancel, sink: sink,
		sessionID: req.SessionID, sessionNonce: nonce, role: req.Side, signalRole: req.SignalRole,
		protocol: req.Protocol.ID, abi: req.Protocol.ABI, transport: req.Protocol.Transport, approval: req.Protocol.Approval,
		pluginID: req.Plugin.ID, pluginVer: req.Plugin.Version, action: req.Plugin.Action,
		input: append(json.RawMessage(nil), req.Input...), operatorID: req.OperatorID,
		userID: req.UserID, peer: req.Peer, stunURLs: append([]string(nil), req.STUNURLs...),
		roundNo:    1,
		epoch:      &pluginPeerEpoch{roundID: req.RoundID},
		usedRounds: map[string]int{req.RoundID: 1},
	}, nil
}

func (a *Agent) handlePluginPeerPrepare(ctx context.Context, sink EnvelopeSink, env Envelope) bool {
	req, err := decodePluginPeerPrepare(env.Body)
	if err != nil {
		a.sendPluginPeerFailure(ctx, sink, fmt.Sprint(env.Body["session_id"]), fmt.Sprint(env.Body["round_id"]), "INVALID_PREPARE")
		return false
	}
	meta, _, err := resolveInstalledPluginPeerAction(req.Plugin.ID, req.Protocol.ID, req.Side, req.Plugin.Action)
	if err != nil || meta.Version != req.Plugin.Version {
		a.sendPluginPeerFailure(ctx, sink, req.SessionID, req.RoundID, "PLUGIN_UNAVAILABLE")
		return false
	}
	s, err := newPluginPeerSession(a, ctx, sink, req)
	if err != nil {
		a.sendPluginPeerFailure(ctx, sink, req.SessionID, req.RoundID, "RANDOM_UNAVAILABLE")
		return false
	}
	a.mu.Lock()
	if a.authRevoked || !a.enabled || a.permit == PermitOff {
		a.mu.Unlock()
		a.sendPluginPeerFailure(ctx, sink, req.SessionID, req.RoundID, "DEVICE_DISABLED")
		return false
	}
	if a.peerSessions == nil {
		a.peerSessions = make(map[string]*pluginPeerSession)
	}
	if existing := a.peerSessions[req.SessionID]; existing != nil {
		a.mu.Unlock()
		return existing.matchesPrepare(req)
	}
	if len(a.peerSessions) >= pluginPeerSessionMax || a.pending != nil {
		a.mu.Unlock()
		a.sendPluginPeerFailure(ctx, sink, req.SessionID, req.RoundID, "SESSION_LIMIT")
		return false
	}
	a.peerSessions[req.SessionID] = s
	label := a.queuePluginPeerApprovalLocked(s, env.Corr, req.RoundID)
	a.mu.Unlock()
	notifyConsent(label)
	a.pushUI()
	return true
}

func (s *pluginPeerSession) matchesPrepare(req pluginPeerPrepareRequest) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, knownRound := s.usedRounds[req.RoundID]
	return !s.closed && knownRound && s.sessionID == req.SessionID && s.role == req.Side &&
		s.signalRole == req.SignalRole && s.protocol == req.Protocol.ID && s.abi == req.Protocol.ABI &&
		s.transport == req.Protocol.Transport && s.approval == req.Protocol.Approval &&
		s.pluginID == req.Plugin.ID && s.pluginVer == req.Plugin.Version && s.action == req.Plugin.Action &&
		s.operatorID == req.OperatorID && s.userID == req.UserID && s.peer == req.Peer &&
		string(s.input) == string(req.Input) && slices.Equal(s.stunURLs, req.STUNURLs)
}

func (a *Agent) queuePluginPeerApprovalLocked(s *pluginPeerSession, corr, roundID string) string {
	peer := s.peer.Name
	if peer == "" {
		peer = s.peer.Kind + ":" + s.peer.ID
	}
	label := fmt.Sprintf(
		"allow plugin %s %s action %s as %s with %s; input %s",
		s.pluginID, s.pluginVer, s.action, s.role, peer, canonicalPluginPeerInput(s.input),
	)
	a.pending = &Pending{
		Kind: pendingKindPluginPeer, Corr: corr, Command: label, Requested: time.Now().UnixMilli(), Sink: s.sink,
		Peer: &pluginPeerPendingApproval{session: s, approve: func() { s.approve(roundID) }, deny: func(err error) { s.fail("DENIED", err) }},
	}
	a.log("warn", "waiting consent: "+label)
	return label
}

func canonicalPluginPeerInput(raw json.RawMessage) string {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return "null"
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		return "null"
	}
	return clip(string(canonical), 320)
}

func (s *pluginPeerSession) approve(roundID string) {
	s.mu.Lock()
	if s.closed || s.approved {
		s.mu.Unlock()
		return
	}
	s.approved = true
	s.mu.Unlock()
	go s.startEpoch(roundID)
}

func (s *pluginPeerSession) startEpoch(roundID string) {
	if !rtcSIDPattern.MatchString(roundID) {
		s.fail("INVALID_ROUND", errors.New("invalid plugin peer round"))
		return
	}
	nonce, err := newPluginPeerNonce()
	if err != nil {
		s.fail("RANDOM_UNAVAILABLE", err)
		return
	}
	s.mu.Lock()
	if s.closed || !s.approved || (s.epoch != nil && s.epoch.ctx != nil) {
		s.mu.Unlock()
		return
	}
	s.nextGeneration++
	ctx, cancel := context.WithCancel(s.ctx)
	e := &pluginPeerEpoch{generation: s.nextGeneration, roundID: roundID, nonce: nonce, ctx: ctx, cancel: cancel}
	s.epoch = e
	s.mu.Unlock()

	meta, plugin, err := openPluginPeer(e.ctx, s.pluginID, s.protocol, s.role, s.action)
	if err != nil {
		s.failEpoch(e, "PLUGIN_UNAVAILABLE", err)
		return
	}
	declaration, err := pluginPeerAction(meta, s.protocol, s.role, s.action)
	if err != nil {
		plugin.Abort()
		s.failEpoch(e, "PLUGIN_UNAVAILABLE", err)
		return
	}
	s.mu.Lock()
	if s.closed || s.epoch != e {
		s.mu.Unlock()
		plugin.Abort()
		return
	}
	if declaration.ABI != s.abi || declaration.Transport != s.transport || declaration.Approval != s.approval {
		s.mu.Unlock()
		plugin.Abort()
		s.failEpoch(e, "PLUGIN_CHANGED", errors.New("installed plugin declaration does not match prepared protocol"))
		return
	}
	if s.pluginVer != meta.Version || s.abi != declaration.ABI || s.transport != declaration.Transport || s.approval != declaration.Approval {
		s.mu.Unlock()
		plugin.Abort()
		s.failEpoch(e, "PLUGIN_CHANGED", errors.New("plugin declaration changed during peer session"))
		return
	}
	e.plugin = plugin
	s.mu.Unlock()
	if err := plugin.WriteControl(pluginPeerOpen(s.action, s.input, s.peer)); err != nil {
		s.failEpoch(e, "PLUGIN_PROTOCOL", err)
		return
	}
	go s.readPlugin(e, plugin)
}

func (s *pluginPeerSession) readPlugin(e *pluginPeerEpoch, plugin pluginPeerIO) {
	for {
		record, err := plugin.ReadRecord()
		if err != nil {
			s.mu.Lock()
			current := !s.closed && s.epoch == e && e.plugin == plugin
			s.mu.Unlock()
			if current && !errors.Is(err, context.Canceled) {
				s.failEpoch(e, "PLUGIN_PROTOCOL", err)
			}
			return
		}
		if record.Kind == pluginPeerRecordData {
			s.sendPluginData(e, plugin, record.Payload)
			continue
		}
		control, err := decodePluginPeerControl(record.Payload)
		if err != nil {
			s.failEpoch(e, "PLUGIN_PROTOCOL", err)
			return
		}
		if !s.handlePluginStatus(e, plugin, control) {
			return
		}
	}
}

func (s *pluginPeerSession) handlePluginStatus(e *pluginPeerEpoch, plugin pluginPeerIO, control pluginPeerControl) bool {
	if control.Type != "status" {
		s.failEpoch(e, "PLUGIN_PROTOCOL", errors.New("plugin emitted non-status control"))
		return false
	}
	s.mu.Lock()
	if s.closed || s.epoch != e || e.plugin != plugin {
		s.mu.Unlock()
		return false
	}
	switch control.Status {
	case "ready":
		if e.ready {
			s.mu.Unlock()
			s.failEpoch(e, "PLUGIN_PROTOCOL", errors.New("plugin emitted duplicate ready status"))
			return false
		}
		e.ready = true
		signaling := e.signaling
		initiator := s.signalRole == "initiator"
		queuedOffer := e.queuedOffer
		e.queuedOffer = ""
		s.mu.Unlock()
		s.sendAuthorized(e)
		if queuedOffer != "" {
			go s.acceptOffer(e, queuedOffer)
		} else if signaling && initiator {
			go s.beginOffer(e)
		}
		return true
	case "complete":
		if !e.ready {
			s.mu.Unlock()
			s.failEpoch(e, "PLUGIN_PROTOCOL", errors.New("plugin completed outside its ready lifetime"))
			return false
		}
		if e.localComplete {
			s.mu.Unlock()
			s.failEpoch(e, "PLUGIN_PROTOCOL", errors.New("plugin emitted duplicate complete status"))
			return false
		}
		e.localComplete = true
		r := e.round
		ready := s.roundCurrentLocked(r) && r.dataOpen && !e.flushing
		s.mu.Unlock()
		if ready {
			s.finishLocalHalf(r)
		}
		return false
	case "canceled":
		// Claim the terminal transition while this epoch is still current. A
		// concurrent RTC failure must not install a replacement epoch between
		// this check and close(), only to have this old plugin callback kill it.
		s.closed = true
		s.mu.Unlock()
		s.sendEvent(e.roundID, "cancel", normalizePluginPeerFailureCode(control.Code, "CANCELLED"))
		s.close()
		return false
	case "error":
		s.mu.Unlock()
		s.failEpoch(e, control.Code, errors.New(control.Error))
		return false
	default:
		s.mu.Unlock()
		s.failEpoch(e, "PLUGIN_PROTOCOL", fmt.Errorf("unknown plugin status %q", control.Status))
		return false
	}
}

func (s *pluginPeerSession) sendAuthorized(e *pluginPeerEpoch) {
	s.mu.Lock()
	if s.closed || s.epoch != e || !e.ready || e.authorized {
		s.mu.Unlock()
		return
	}
	e.authorized = true
	body := map[string]any{
		"session_id":      s.sessionID,
		"round_id":        e.roundID,
		"side":            s.role,
		"session_binding": s.sessionNonce,
		"round_binding":   e.nonce,
	}
	s.mu.Unlock()
	_ = s.sendControl(Envelope{V: 1, Type: "peer_session_authorized", ID: newPluginPeerMessageID(), T: time.Now().UnixMilli(), Body: body})
}

func (s *pluginPeerSession) sendEvent(roundID, event, code string) error {
	body := map[string]any{"session_id": s.sessionID, "round_id": roundID, "event": event}
	if code != "" {
		body["failure_code"] = normalizePluginPeerFailureCode(code, "PLUGIN_PEER_FAILED")
	}
	return s.sendControl(Envelope{V: 1, Type: "peer_session_event", ID: newPluginPeerMessageID(), T: time.Now().UnixMilli(), Body: body})
}

func (s *pluginPeerSession) sendControl(env Envelope) error {
	if s.sink == nil {
		return errors.New("plugin peer control channel unavailable")
	}
	return s.sink(s.ctx, env)
}

func (a *Agent) sendPluginPeerFailure(ctx context.Context, sink EnvelopeSink, sessionID, roundID, code string) {
	if sink == nil || sessionID == "" || roundID == "" {
		return
	}
	_ = sink(ctx, Envelope{V: 1, Type: "peer_session_event", ID: newPluginPeerMessageID(), T: time.Now().UnixMilli(), Body: map[string]any{
		"session_id": sessionID, "round_id": roundID, "event": "fail", "failure_code": code,
	}})
}

func (a *Agent) handlePluginPeerDelivery(ctx context.Context, sink EnvelopeSink, env Envelope) {
	deliveryID, _ := env.Body["delivery_id"].(string)
	sessionID, _ := env.Body["session_id"].(string)
	if !pluginPeerDeliveryRE.MatchString(deliveryID) || !rtcSIDPattern.MatchString(sessionID) {
		return
	}
	a.mu.Lock()
	_, duplicate := a.peerDeliveries[deliveryID]
	a.mu.Unlock()
	handled := duplicate
	if !duplicate {
		switch env.Type {
		case "peer_session_prepare":
			handled = a.handlePluginPeerPrepare(ctx, sink, env)
		case "peer_session_round_prepare":
			handled = a.handlePluginPeerRoundPrepare(env)
		case "peer_session_signal":
			handled = a.handlePluginPeerSignal(env)
		case "peer_session_ticket":
			handled = a.handlePluginPeerTicket(env)
		case "peer_session_update":
			handled = a.handlePluginPeerUpdate(env)
		}
	}
	if !handled {
		return
	}
	if !duplicate {
		a.mu.Lock()
		if a.peerDeliveries == nil {
			a.peerDeliveries = make(map[string]struct{})
		}
		a.peerDeliveries[deliveryID] = struct{}{}
		a.peerDeliveryOrder = append(a.peerDeliveryOrder, deliveryID)
		if len(a.peerDeliveryOrder) > 256 {
			oldest := a.peerDeliveryOrder[0]
			a.peerDeliveryOrder = a.peerDeliveryOrder[1:]
			delete(a.peerDeliveries, oldest)
		}
		a.mu.Unlock()
	}
	_ = sink(ctx, Envelope{V: 1, Type: "peer_session_ack", ID: newPluginPeerMessageID(), T: time.Now().UnixMilli(), Body: map[string]any{
		"session_id": sessionID, "delivery_id": deliveryID,
	}})
}

func newPluginPeerMessageID() string { return fmt.Sprintf("%d", time.Now().UnixNano()) }

func validPluginPeerSDP(sdp string) bool {
	lower := strings.ToLower(sdp)
	return len(sdp) > 0 && len(sdp) <= pluginPeerSignalMax && canonicalPluginPeerFingerprint(sdp) != "" &&
		!pluginPeerRelayRE.MatchString(lower) && !strings.Contains(lower, "turn:") && !strings.Contains(lower, "turns:")
}

func (s *pluginPeerSession) newPeerConnection() (*webrtc.PeerConnection, error) {
	servers := make([]webrtc.ICEServer, 0, 1)
	if len(s.stunURLs) > 0 {
		servers = append(servers, webrtc.ICEServer{URLs: append([]string(nil), s.stunURLs...)})
	}
	return webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: servers})
}

func (s *pluginPeerSession) reserveRoundLocked(e *pluginPeerEpoch, pc *webrtc.PeerConnection) (*pluginPeerRound, bool) {
	if e == nil || s.closed || s.epoch != e || !e.ready || e.round != nil {
		return nil, false
	}
	ctx, cancel := context.WithCancel(e.ctx)
	r := &pluginPeerRound{epoch: e, ctx: ctx, cancel: cancel, pc: pc, inbox: make(chan pluginPeerIncoming, pluginPeerInboxMax)}
	e.round = r
	return r, true
}

func (s *pluginPeerSession) roundCurrentLocked(r *pluginPeerRound) bool {
	return r != nil && !s.closed && s.epoch == r.epoch && r.epoch.round == r
}

func (s *pluginPeerSession) roundCurrent(r *pluginPeerRound) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.roundCurrentLocked(r)
}

func (s *pluginPeerSession) beginOffer(e *pluginPeerEpoch) {
	s.mu.Lock()
	if s.closed || s.epoch != e || s.signalRole != "initiator" || !e.ready || !e.signaling || e.round != nil {
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	pc, err := s.newPeerConnection()
	if err != nil {
		s.failEpoch(e, "SIGNAL_ERROR", err)
		return
	}
	dc, err := pc.CreateDataChannel("fleet-plugin-peer-v1", nil)
	if err != nil {
		_ = pc.Close()
		s.failEpoch(e, "SIGNAL_ERROR", err)
		return
	}
	s.mu.Lock()
	r, ok := s.reserveRoundLocked(e, pc)
	s.mu.Unlock()
	if !ok {
		_ = pc.Close()
		return
	}
	s.attachDataChannel(r, dc)
	s.installPeerConnectionState(r, pc)
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		s.failRound(r, "SIGNAL_ERROR", err)
		return
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		s.failRound(r, "SIGNAL_ERROR", err)
		return
	}
	if err := waitPluginPeerGather(r.ctx, gathered); err != nil {
		s.failRound(r, "SIGNAL_ERROR", err)
		return
	}
	local := pc.LocalDescription()
	if local == nil || !validPluginPeerSDP(local.SDP) {
		s.failRound(r, "SIGNAL_ERROR", errors.New("invalid or relayed plugin peer offer"))
		return
	}
	s.mu.Lock()
	if !s.roundCurrentLocked(r) {
		s.mu.Unlock()
		return
	}
	r.offer = local.SDP
	s.mu.Unlock()
	if err := s.sendSignal(r, pluginPeerSignal{Kind: "offer", Seq: 0, SDP: local.SDP}); err != nil {
		s.failRound(r, "SIGNAL_ERROR", err)
	}
}

func (s *pluginPeerSession) acceptOffer(e *pluginPeerEpoch, offer string) {
	pc, err := s.newPeerConnection()
	if err != nil {
		s.failEpoch(e, "SIGNAL_ERROR", err)
		return
	}
	s.mu.Lock()
	if s.closed || s.epoch != e || s.signalRole != "responder" || !e.ready || e.round != nil {
		s.mu.Unlock()
		_ = pc.Close()
		return
	}
	r, ok := s.reserveRoundLocked(e, pc)
	if ok {
		r.offer = offer
	}
	s.mu.Unlock()
	if !ok {
		_ = pc.Close()
		return
	}
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() != "fleet-plugin-peer-v1" {
			_ = dc.Close()
			return
		}
		s.attachDataChannel(r, dc)
	})
	s.installPeerConnectionState(r, pc)
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); err != nil {
		s.failRound(r, "SIGNAL_ERROR", err)
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		s.failRound(r, "SIGNAL_ERROR", err)
		return
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		s.failRound(r, "SIGNAL_ERROR", err)
		return
	}
	if err := waitPluginPeerGather(r.ctx, gathered); err != nil {
		s.failRound(r, "SIGNAL_ERROR", err)
		return
	}
	local := pc.LocalDescription()
	if local == nil || !validPluginPeerSDP(local.SDP) {
		s.failRound(r, "SIGNAL_ERROR", errors.New("invalid or relayed plugin peer answer"))
		return
	}
	s.mu.Lock()
	if !s.roundCurrentLocked(r) {
		s.mu.Unlock()
		return
	}
	r.answer = local.SDP
	s.mu.Unlock()
	if err := s.sendSignal(r, pluginPeerSignal{Kind: "answer", Seq: 0, SDP: local.SDP}); err != nil {
		s.failRound(r, "SIGNAL_ERROR", err)
	}
}

func waitPluginPeerGather(ctx context.Context, gathered <-chan struct{}) error {
	timer := time.NewTimer(pluginPeerGatherWait)
	defer timer.Stop()
	select {
	case <-gathered:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return errors.New("plugin peer ICE gathering timeout")
	}
}

func (s *pluginPeerSession) installPeerConnectionState(r *pluginPeerRound, pc *webrtc.PeerConnection) {
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateDisconnected || state == webrtc.PeerConnectionStateClosed {
			s.peerConnectionFailure(r, fmt.Errorf("%w: connection %s", errPluginPeerDirect, state.String()))
		}
	})
}

func (s *pluginPeerSession) peerConnectionFailure(r *pluginPeerRound, err error) {
	s.mu.Lock()
	if !s.roundCurrentLocked(r) {
		s.mu.Unlock()
		return
	}
	dc := r.dc
	s.mu.Unlock()
	if dc == nil {
		s.failRound(r, "DIRECT_UNAVAILABLE", err)
		return
	}
	s.dataChannelFailure(r, dc, err)
}

func (s *pluginPeerSession) sendSignal(r *pluginPeerRound, signal pluginPeerSignal) error {
	return s.sendControl(Envelope{
		V: 1, Type: "peer_session_signal", ID: newPluginPeerMessageID(), T: time.Now().UnixMilli(),
		Body: map[string]any{"session_id": s.sessionID, "round_id": r.epoch.roundID, "signal_role": s.signalRole, "signal": signal},
	})
}

func (a *Agent) handlePluginPeerSignal(env Envelope) bool {
	b, err := json.Marshal(env.Body)
	if err != nil {
		return false
	}
	var message pluginPeerSignalEnvelope
	if json.Unmarshal(b, &message) != nil || !rtcSIDPattern.MatchString(message.SessionID) ||
		!rtcSIDPattern.MatchString(message.RoundID) ||
		message.Signal.Seq < 0 || (message.Signal.Kind != "offer" && message.Signal.Kind != "answer") ||
		!validPluginPeerSDP(message.Signal.SDP) {
		return false
	}
	a.mu.Lock()
	s := a.peerSessions[message.SessionID]
	a.mu.Unlock()
	if s == nil {
		return false
	}
	s.mu.Lock()
	e := s.epoch
	if e == nil || e.roundID != message.RoundID {
		_, used := s.usedRounds[message.RoundID]
		s.mu.Unlock()
		return used
	}
	if (message.From != "initiator" && message.From != "responder") || message.From == s.signalRole {
		s.mu.Unlock()
		return false
	}
	if s.signalRole == "responder" && message.From == "initiator" && message.Signal.Kind == "offer" {
		if !e.ready {
			if e.queuedOffer != "" && e.queuedOffer != message.Signal.SDP {
				s.mu.Unlock()
				return false
			}
			e.queuedOffer = message.Signal.SDP
			s.mu.Unlock()
			return true
		}
		s.mu.Unlock()
		go s.acceptOffer(e, message.Signal.SDP)
		return true
	}
	if s.signalRole == "initiator" && message.From == "responder" && message.Signal.Kind == "answer" {
		r := e.round
		if !s.roundCurrentLocked(r) {
			s.mu.Unlock()
			return false
		}
		if r.answer != "" {
			same := r.answer == message.Signal.SDP
			s.mu.Unlock()
			return same
		}
		pc := r.pc
		s.mu.Unlock()
		if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: message.Signal.SDP}); err != nil {
			s.failRound(r, "SIGNAL_ERROR", err)
			return true
		}
		s.mu.Lock()
		if s.roundCurrentLocked(r) {
			r.answer = message.Signal.SDP
		}
		s.mu.Unlock()
		return true
	}
	s.mu.Unlock()
	return false
}

func (s *pluginPeerSession) attachDataChannel(r *pluginPeerRound, dc *webrtc.DataChannel) {
	s.mu.Lock()
	if !s.roundCurrentLocked(r) || r.dc != nil {
		s.mu.Unlock()
		_ = dc.Close()
		return
	}
	r.dc = dc
	s.mu.Unlock()
	dc.OnOpen(func() { s.dataChannelOpen(r, dc) })
	dc.OnMessage(func(message webrtc.DataChannelMessage) { s.dataChannelMessage(r, dc, message.IsString, message.Data) })
	dc.OnClose(func() { s.dataChannelFailure(r, dc, fmt.Errorf("%w: channel closed", errPluginPeerDirect)) })
	dc.OnError(func(err error) { s.dataChannelFailure(r, dc, fmt.Errorf("%w: %v", errPluginPeerDirect, err)) })
	go s.readRound(r)
}

func (s *pluginPeerSession) dataChannelOpen(r *pluginPeerRound, dc pluginPeerDataChannel) {
	s.mu.Lock()
	if !s.roundCurrentLocked(r) || r.dc != dc {
		s.mu.Unlock()
		return
	}
	r.open = true
	s.mu.Unlock()
	s.maybeSendBindings(r)
}

func (s *pluginPeerSession) dataChannelMessage(r *pluginPeerRound, dc pluginPeerDataChannel, text bool, raw []byte) {
	limit := pluginPeerDataMax
	if text {
		limit = pluginPeerControlMax
	}
	s.mu.Lock()
	if !s.roundCurrentLocked(r) || r.dc != dc {
		s.mu.Unlock()
		return
	}
	if len(raw) > limit || r.inboxBytes+len(raw) > pluginPeerInboxBytesMax || len(r.inbox) >= pluginPeerInboxMax {
		s.mu.Unlock()
		s.failRound(r, "BACKPRESSURE", errors.New("plugin peer receive window exceeded"))
		return
	}
	r.inboxBytes += len(raw)
	s.mu.Unlock()
	message := pluginPeerIncoming{text: text, data: append([]byte(nil), raw...)}
	select {
	case r.inbox <- message:
	case <-r.ctx.Done():
		s.mu.Lock()
		if s.roundCurrentLocked(r) {
			r.inboxBytes -= len(raw)
		}
		s.mu.Unlock()
	}
}

func (s *pluginPeerSession) readRound(r *pluginPeerRound) {
	for {
		select {
		case <-r.ctx.Done():
			return
		case message := <-r.inbox:
			s.mu.Lock()
			if s.roundCurrentLocked(r) {
				r.inboxBytes -= len(message.data)
			}
			current := s.roundCurrentLocked(r)
			s.mu.Unlock()
			if !current {
				return
			}
			if message.text {
				if err := s.handlePeerControl(r, message.data); err != nil {
					s.failRound(r, "PEER_PROTOCOL", err)
					return
				}
				continue
			}
			s.mu.Lock()
			allowed := s.roundCurrentLocked(r) && r.dataOpen && !r.remoteDone
			plugin := r.epoch.plugin
			if allowed {
				r.started = true
			}
			s.mu.Unlock()
			if !allowed || plugin == nil {
				s.failRound(r, "PEER_PROTOCOL", errors.New("peer data arrived before round readiness"))
				return
			}
			if err := plugin.WriteData(message.data); err != nil {
				s.failRound(r, "PLUGIN_PROTOCOL", err)
				return
			}
		}
	}
}

type pluginPeerDCControl struct {
	V    int    `json:"v"`
	Type string `json:"type"`
	ID   string `json:"id"`
	T    int64  `json:"t"`
	Body struct {
		SessionID      string `json:"session_id"`
		RoundID        string `json:"round_id"`
		SessionBinding string `json:"session_binding,omitempty"`
		RoundBinding   string `json:"round_binding,omitempty"`
		Code           string `json:"code,omitempty"`
		Error          string `json:"error,omitempty"`
	} `json:"body"`
}

func (s *pluginPeerSession) handlePeerControl(r *pluginPeerRound, raw []byte) error {
	var control pluginPeerDCControl
	if json.Unmarshal(raw, &control) != nil || control.V != 1 || control.ID == "" || control.T <= 0 ||
		control.Body.SessionID != s.sessionID || control.Body.RoundID != r.epoch.roundID {
		return errors.New("invalid plugin peer control")
	}
	switch control.Type {
	case "peer_bindings":
		if !validPluginPeerNonce(control.Body.SessionBinding) || !validPluginPeerNonce(control.Body.RoundBinding) {
			return errors.New("invalid peer bindings")
		}
		s.mu.Lock()
		err := s.acceptPeerBindingsLocked(r, control.Body.SessionBinding, control.Body.RoundBinding)
		s.mu.Unlock()
		if err != nil {
			return err
		}
		s.maybeSendPeerReady(r)
		return nil
	case "peer_ready":
		s.mu.Lock()
		if !s.roundCurrentLocked(r) || !r.ticketVerified || !r.peerBindingOK || !r.bindingSent {
			s.mu.Unlock()
			return errors.New("peer became ready before authorization")
		}
		r.remoteReady = true
		s.mu.Unlock()
		s.maybeSendPeerReady(r)
		s.activateRound(r)
		return nil
	case "peer_cancel":
		go s.cancelFromPeer(r, control.Body.Code)
		return nil
	case "peer_error":
		return fmt.Errorf("peer failed: %s: %s", control.Body.Code, control.Body.Error)
	case "peer_done":
		s.mu.Lock()
		if !s.roundCurrentLocked(r) || !r.dataOpen {
			s.mu.Unlock()
			return errors.New("peer completed before round readiness")
		}
		if r.remoteDone {
			s.mu.Unlock()
			return nil
		}
		r.remoteDone = true
		finish := r.localDoneSent
		s.mu.Unlock()
		if finish {
			s.finishCompletedRound(r)
		} else {
			s.startHalfCloseWatch(r)
		}
		return nil
	default:
		return errors.New("unknown plugin peer control")
	}
}

// acceptPeerBindingsLocked records structurally valid early bindings but does
// not trust them until the independently signed Hub ticket arrives.
func (s *pluginPeerSession) acceptPeerBindingsLocked(r *pluginPeerRound, sessionBinding, roundBinding string) error {
	if !s.roundCurrentLocked(r) || r.peerBindingOK {
		return errors.New("peer binding hash mismatch")
	}
	if !r.ticketVerified {
		if r.pendingPeerSessionBinding != "" &&
			(r.pendingPeerSessionBinding != sessionBinding || r.pendingPeerRoundBinding != roundBinding) {
			return errors.New("peer binding changed before ticket verification")
		}
		r.pendingPeerSessionBinding = sessionBinding
		r.pendingPeerRoundBinding = roundBinding
		return nil
	}
	if pluginPeerBindingHash(sessionBinding) != r.peerSessionHash ||
		pluginPeerBindingHash(roundBinding) != r.peerRoundHash {
		return errors.New("peer binding hash mismatch")
	}
	r.peerBindingOK = true
	r.pendingPeerSessionBinding = ""
	r.pendingPeerRoundBinding = ""
	return nil
}

func (s *pluginPeerSession) marshalPeerControl(r *pluginPeerRound, kind, code string, extra map[string]any) ([]byte, error) {
	body := map[string]any{"session_id": s.sessionID, "round_id": r.epoch.roundID}
	if code != "" {
		body["code"] = code
	}
	for key, value := range extra {
		body[key] = value
	}
	payload, err := json.Marshal(map[string]any{"v": 1, "type": kind, "id": newPluginPeerMessageID(), "t": time.Now().UnixMilli(), "body": body})
	if err != nil || len(payload) > pluginPeerControlMax {
		return nil, errors.New("plugin peer control exceeds limit")
	}
	return payload, nil
}

func (s *pluginPeerSession) sendPeerControl(r *pluginPeerRound, kind, code string, extra map[string]any) error {
	payload, err := s.marshalPeerControl(r, kind, code, extra)
	if err != nil {
		return err
	}
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	s.mu.Lock()
	if !s.roundCurrentLocked(r) || r.dc == nil || !r.open {
		s.mu.Unlock()
		return fmt.Errorf("%w: channel unavailable", errPluginPeerDirect)
	}
	dc := r.dc
	s.mu.Unlock()
	if err := dc.SendText(string(payload)); err != nil {
		return fmt.Errorf("%w: %v", errPluginPeerDirect, err)
	}
	return nil
}

func (s *pluginPeerSession) maybeSendBindings(r *pluginPeerRound) {
	payload, err := s.marshalPeerControl(r, "peer_bindings", "", map[string]any{
		"session_binding": s.sessionNonce,
		"round_binding":   r.epoch.nonce,
	})
	if err == nil {
		s.sendMu.Lock()
		s.mu.Lock()
		if !s.roundCurrentLocked(r) || !r.ticketVerified || !r.open || r.bindingSent || r.dc == nil {
			s.mu.Unlock()
			s.sendMu.Unlock()
			return
		}
		dc := r.dc
		s.mu.Unlock()
		err = dc.SendText(string(payload))
		if err == nil {
			s.mu.Lock()
			if s.roundCurrentLocked(r) && r.dc == dc {
				r.bindingSent = true
			}
			s.mu.Unlock()
		}
		s.sendMu.Unlock()
	}
	if err != nil {
		s.failRound(r, "DIRECT_UNAVAILABLE", err)
		return
	}
	s.maybeSendPeerReady(r)
}

func (s *pluginPeerSession) maybeSendPeerReady(r *pluginPeerRound) {
	payload, err := s.marshalPeerControl(r, "peer_ready", "", nil)
	if err == nil {
		s.sendMu.Lock()
		s.mu.Lock()
		if !s.roundCurrentLocked(r) || !r.ticketVerified || !r.peerBindingOK || !r.bindingSent ||
			!r.open || r.readySent || r.dc == nil {
			s.mu.Unlock()
			s.sendMu.Unlock()
			return
		}
		dc := r.dc
		s.mu.Unlock()
		err = dc.SendText(string(payload))
		if err == nil {
			s.mu.Lock()
			if s.roundCurrentLocked(r) && r.dc == dc {
				r.readySent = true
			}
			s.mu.Unlock()
		}
		s.sendMu.Unlock()
	}
	if err != nil {
		s.failRound(r, "DIRECT_UNAVAILABLE", err)
		return
	}
	s.activateRound(r)
}

func (s *pluginPeerSession) sendPluginData(e *pluginPeerEpoch, plugin pluginPeerIO, data []byte) {
	s.mu.Lock()
	r := e.round
	if s.closed || s.epoch != e || e.plugin != plugin || !e.ready || e.localComplete {
		s.mu.Unlock()
		s.failEpoch(e, "PLUGIN_PROTOCOL", errors.New("plugin emitted DATA outside its ready lifetime"))
		return
	}
	if !s.roundCurrentLocked(r) || !r.dataOpen || e.flushing {
		if len(e.pendingData) >= pluginPeerInboxMax || e.pendingBytes+len(data) > pluginPeerInboxBytesMax {
			s.mu.Unlock()
			s.failEpoch(e, "BACKPRESSURE", errors.New("plugin pre-ready DATA queue exceeded its hard limit"))
			return
		}
		e.pendingData = append(e.pendingData, append([]byte(nil), data...))
		e.pendingBytes += len(data)
		s.mu.Unlock()
		return
	}
	r.started = true
	s.mu.Unlock()
	s.sendPluginDataNow(r, data)
}

func (s *pluginPeerSession) sendPluginDataNow(r *pluginPeerRound, data []byte) {
	s.mu.Lock()
	if !s.roundCurrentLocked(r) || !r.dataOpen || r.dc == nil {
		s.mu.Unlock()
		return
	}
	r.started = true
	dc, ctx := r.dc, r.ctx
	s.mu.Unlock()
	for dc.BufferedAmount()+uint64(len(data)) > pluginPeerSendWindow {
		select {
		case <-ctx.Done():
			return
		case <-time.After(10 * time.Millisecond):
		}
	}
	if !s.roundCurrent(r) {
		return
	}
	s.sendMu.Lock()
	err := dc.Send(data)
	s.sendMu.Unlock()
	if err != nil {
		s.dataChannelFailure(r, dc, err)
	}
}

func (s *pluginPeerSession) activateRound(r *pluginPeerRound) {
	s.mu.Lock()
	if !s.roundCurrentLocked(r) || !r.ticketVerified || !r.peerBindingOK || !r.readySent || !r.remoteReady ||
		r.dataOpen || r.dc == nil {
		s.mu.Unlock()
		return
	}
	r.dataOpen = true
	r.activeSent = true
	r.epoch.flushing = true
	s.mu.Unlock()
	if err := s.sendEvent(r.epoch.roundID, "active", ""); err != nil {
		s.failRound(r, "CONTROL_UNAVAILABLE", err)
		return
	}
	s.mu.Lock()
	if !s.roundCurrentLocked(r) {
		s.mu.Unlock()
		return
	}
	r.started = true
	s.mu.Unlock()
	go s.flushPluginQueue(r)
}

func (s *pluginPeerSession) flushPluginQueue(r *pluginPeerRound) {
	for {
		s.mu.Lock()
		if !s.roundCurrentLocked(r) || !r.dataOpen {
			s.mu.Unlock()
			return
		}
		e := r.epoch
		if len(e.pendingData) == 0 {
			e.flushing = false
			complete := e.localComplete
			s.mu.Unlock()
			if complete {
				s.finishLocalHalf(r)
			}
			return
		}
		data := e.pendingData[0]
		e.pendingData = e.pendingData[1:]
		e.pendingBytes -= len(data)
		s.mu.Unlock()
		s.sendPluginDataNow(r, data)
	}
}

func (s *pluginPeerSession) finishLocalHalf(r *pluginPeerRound) {
	s.mu.Lock()
	if !s.roundCurrentLocked(r) || !r.dataOpen || !r.epoch.localComplete || r.epoch.flushing ||
		r.localDoneSent || r.localDoneDraining || r.dc == nil {
		s.mu.Unlock()
		return
	}
	r.localDoneDraining = true
	dc, ctx := r.dc, r.ctx
	s.mu.Unlock()
	go func() {
		deadline := time.NewTimer(30 * time.Second)
		defer deadline.Stop()
		for dc.BufferedAmount() > 0 {
			select {
			case <-ctx.Done():
				return
			case <-deadline.C:
				s.failRound(r, "DIRECT_UNAVAILABLE", errors.New("plugin peer DATA drain timed out"))
				return
			case <-time.After(5 * time.Millisecond):
			}
		}
		if err := s.sendPeerControl(r, "peer_done", "", nil); err != nil {
			s.failRound(r, "DIRECT_UNAVAILABLE", err)
			return
		}
		s.mu.Lock()
		if !s.roundCurrentLocked(r) {
			s.mu.Unlock()
			return
		}
		r.localDoneSent = true
		r.localDoneDraining = false
		finish := r.remoteDone
		s.mu.Unlock()
		if finish {
			s.finishCompletedRound(r)
		} else {
			s.startHalfCloseWatch(r)
		}
	}()
}

func (s *pluginPeerSession) startHalfCloseWatch(r *pluginPeerRound) {
	s.mu.Lock()
	if !s.roundCurrentLocked(r) || r.halfCloseWatch || (r.localDoneSent && r.remoteDone) {
		s.mu.Unlock()
		return
	}
	r.halfCloseWatch = true
	ctx := r.ctx
	wait := s.halfCloseWait
	if wait <= 0 {
		wait = pluginPeerHalfCloseWait
	}
	s.mu.Unlock()
	go func() {
		timer := time.NewTimer(wait)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		s.mu.Lock()
		incomplete := s.roundCurrentLocked(r) && !(r.localDoneSent && r.remoteDone)
		recoverable := r.started
		s.mu.Unlock()
		if !incomplete {
			return
		}
		if recoverable {
			s.interruptRound(r, errors.New("plugin peer half-close timed out"))
			return
		}
		s.failRound(r, "PEER_TIMEOUT", errors.New("plugin peer half-close timed out"))
	}()
}

func (s *pluginPeerSession) finishCompletedRound(r *pluginPeerRound) {
	s.mu.Lock()
	if !s.roundCurrentLocked(r) || !r.localDoneSent || !r.remoteDone || r.completeSent {
		s.mu.Unlock()
		return
	}
	r.completeSent = true
	s.mu.Unlock()
	go s.retryCompleteEvent(r)
}

func (s *pluginPeerSession) retryCompleteEvent(r *pluginPeerRound) {
	for {
		s.mu.Lock()
		if !s.roundCurrentLocked(r) || r.completeAck || s.closed {
			s.mu.Unlock()
			return
		}
		s.mu.Unlock()
		s.sendEvent(r.epoch.roundID, "complete", "")
		select {
		case <-r.ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

func (s *pluginPeerSession) cancelFromPeer(r *pluginPeerRound, code string) {
	s.mu.Lock()
	if !s.roundCurrentLocked(r) {
		s.mu.Unlock()
		return
	}
	// Claim the whole-session cancellation before leaving the lock. Otherwise
	// an old DataChannel callback can race beginNextRound and close the fresh
	// plugin epoch.
	s.closed = true
	s.mu.Unlock()
	s.sendEvent(r.epoch.roundID, "cancel", normalizePluginPeerFailureCode(code, "CANCELLED"))
	s.cancelPluginAndClose()
}

func (s *pluginPeerSession) cancelFromHub() {
	s.mu.Lock()
	r := (*pluginPeerRound)(nil)
	if s.epoch != nil {
		r = s.epoch.round
	}
	s.mu.Unlock()
	if r != nil {
		_ = s.sendPeerControl(r, "peer_cancel", "CANCELLED", nil)
	}
	s.cancelPluginAndClose()
}

func (s *pluginPeerSession) cancelPluginAndClose() {
	s.mu.Lock()
	var plugin pluginPeerIO
	if s.epoch != nil {
		plugin = s.epoch.plugin
		s.epoch.plugin = nil
	}
	s.mu.Unlock()
	if plugin != nil {
		plugin.Cancel()
	}
	s.close()
}

func (s *pluginPeerSession) dataChannelFailure(r *pluginPeerRound, dc pluginPeerDataChannel, err error) {
	s.mu.Lock()
	if !s.roundCurrentLocked(r) || r.dc != dc {
		s.mu.Unlock()
		return
	}
	if r.localDoneSent && r.remoteDone {
		s.mu.Unlock()
		return
	}
	started := r.started
	s.mu.Unlock()
	if started {
		s.interruptRound(r, err)
	} else {
		s.failRound(r, "DIRECT_UNAVAILABLE", err)
	}
}

type pluginPeerTicketEnvelope struct {
	SessionID string               `json:"session_id"`
	RoundID   string               `json:"round_id"`
	Statement signedFleetStatement `json:"statement"`
}

func (a *Agent) handlePluginPeerTicket(env Envelope) bool {
	b, err := json.Marshal(env.Body)
	if err != nil {
		return false
	}
	var ticket pluginPeerTicketEnvelope
	if json.Unmarshal(b, &ticket) != nil || !rtcSIDPattern.MatchString(ticket.SessionID) ||
		!rtcSIDPattern.MatchString(ticket.RoundID) {
		return false
	}
	a.mu.Lock()
	s := a.peerSessions[ticket.SessionID]
	token, kid, deviceID := a.hubToken, a.authKid, a.deviceID
	a.mu.Unlock()
	if s == nil {
		return false
	}
	s.mu.Lock()
	e := s.epoch
	if e == nil || e.roundID != ticket.RoundID {
		_, used := s.usedRounds[ticket.RoundID]
		s.mu.Unlock()
		return used
	}
	if !s.roundCurrentLocked(e.round) {
		s.mu.Unlock()
		return false
	}
	r := e.round
	s.mu.Unlock()
	var statement pluginPeerStatement
	if verifyFleetStatement(token, ticket.Statement, &statement) != nil {
		s.failRound(r, "INVALID_TICKET", errors.New("plugin peer ticket signature invalid"))
		return true
	}
	peerSessionHash, peerRoundHash, err := validatePluginPeerStatement(s, e, r, statement, kid, deviceID, time.Now().UnixMilli())
	if err != nil {
		s.failRound(r, "INVALID_TICKET", err)
		return true
	}
	s.mu.Lock()
	if !s.roundCurrentLocked(r) || s.epoch != e {
		s.mu.Unlock()
		return false
	}
	if r.ticketVerified {
		s.mu.Unlock()
		return true
	}
	r.ticketVerified, r.peerSessionHash, r.peerRoundHash = true, peerSessionHash, peerRoundHash
	var pendingErr error
	if r.pendingPeerSessionBinding != "" {
		pendingErr = s.acceptPeerBindingsLocked(r, r.pendingPeerSessionBinding, r.pendingPeerRoundBinding)
	}
	s.mu.Unlock()
	if pendingErr != nil {
		s.failRound(r, "INVALID_TICKET", pendingErr)
		return true
	}
	s.maybeSendBindings(r)
	s.maybeSendPeerReady(r)
	return true
}

func validatePluginPeerStatement(s *pluginPeerSession, e *pluginPeerEpoch, r *pluginPeerRound, st pluginPeerStatement, kid, deviceID string, now int64) (string, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.epoch != e || !s.roundCurrentLocked(r) || st.V != 1 || st.Kind != "plugin_peer" ||
		st.SessionID != s.sessionID || st.RoundID != e.roundID ||
		st.UserID != s.userID || st.Kid != kid || st.OperatorID != s.operatorID || st.Protocol != s.protocol ||
		st.ABI != s.abi || st.Transport != s.transport || st.Approval != s.approval ||
		!pluginPeerHashRE.MatchString(st.CapabilityDigest) || !st.DirectOnly {
		return "", "", errors.New("plugin peer ticket identity mismatch")
	}
	if st.Iat <= 0 || st.Iat > now+30_000 || st.Exp <= st.Iat || st.Exp <= now || st.Exp-st.Iat > 60_000 {
		return "", "", errors.New("plugin peer ticket expired")
	}
	if st.OfferFP != canonicalPluginPeerFingerprint(r.offer) || st.AnswerFP != canonicalPluginPeerFingerprint(r.answer) {
		return "", "", errors.New("plugin peer ticket transport mismatch")
	}
	localKind, localID := "device", deviceID
	var localPluginID, localPluginVersion, localAction, localRole string
	var peerKind, peerID, peerPluginID, peerPluginVersion, peerAction, peerRole string
	var localSessionHash, localRoundHash, peerSessionHash, peerRoundHash string
	if s.role == "source" {
		if st.SourceKind != localKind || st.SourceID != localID {
			return "", "", errors.New("plugin peer source endpoint mismatch")
		}
		localPluginID, localPluginVersion, localAction, localRole = st.SourcePluginID, st.SourcePluginVersion, st.SourceAction, st.SourceRole
		peerKind, peerID, peerPluginID, peerPluginVersion, peerAction, peerRole = st.TargetKind, st.TargetID, st.TargetPluginID, st.TargetPluginVersion, st.TargetAction, st.TargetRole
		localSessionHash, localRoundHash, peerSessionHash, peerRoundHash = st.SourceSessionBindingHash, st.SourceRoundBindingHash, st.TargetSessionBindingHash, st.TargetRoundBindingHash
	} else {
		if st.TargetKind != localKind || st.TargetID != localID {
			return "", "", errors.New("plugin peer target endpoint mismatch")
		}
		localPluginID, localPluginVersion, localAction, localRole = st.TargetPluginID, st.TargetPluginVersion, st.TargetAction, st.TargetRole
		peerKind, peerID, peerPluginID, peerPluginVersion, peerAction, peerRole = st.SourceKind, st.SourceID, st.SourcePluginID, st.SourcePluginVersion, st.SourceAction, st.SourceRole
		localSessionHash, localRoundHash, peerSessionHash, peerRoundHash = st.TargetSessionBindingHash, st.TargetRoundBindingHash, st.SourceSessionBindingHash, st.SourceRoundBindingHash
	}
	if localPluginID != s.pluginID || localPluginVersion != s.pluginVer || localAction != s.action || localRole != s.role ||
		peerKind != s.peer.Kind || peerID != s.peer.ID || peerPluginID != s.peer.PluginID ||
		peerPluginVersion != s.peer.PluginVersion || peerAction != s.peer.Action || peerRole != s.peer.Role {
		return "", "", errors.New("plugin peer capability mismatch")
	}
	if st.CapabilityDigest != pluginPeerCapabilityDigest(s) {
		return "", "", errors.New("plugin peer capability digest mismatch")
	}
	if pluginPeerBindingHash(s.sessionNonce) != localSessionHash || pluginPeerBindingHash(e.nonce) != localRoundHash ||
		!pluginPeerHashRE.MatchString(peerSessionHash) || !pluginPeerHashRE.MatchString(peerRoundHash) {
		return "", "", errors.New("plugin peer binding mismatch")
	}
	if s.signalRole == "initiator" {
		if st.InitiatorKind != localKind || st.InitiatorID != localID || st.ResponderKind != s.peer.Kind || st.ResponderID != s.peer.ID {
			return "", "", errors.New("plugin peer signaling role mismatch")
		}
	} else if st.ResponderKind != localKind || st.ResponderID != localID || st.InitiatorKind != s.peer.Kind || st.InitiatorID != s.peer.ID {
		return "", "", errors.New("plugin peer signaling role mismatch")
	}
	return peerSessionHash, peerRoundHash, nil
}

type pluginPeerUpdate struct {
	SessionID string `json:"session_id"`
	Phase     string `json:"phase"`
	Session   struct {
		Phase string `json:"phase"`
		Round struct {
			ID string `json:"id"`
		} `json:"round"`
		EndpointEvents map[string]struct {
			Active    bool `json:"active"`
			Completed bool `json:"completed"`
		} `json:"endpoint_events"`
	} `json:"session"`
}

func (a *Agent) handlePluginPeerUpdate(env Envelope) bool {
	b, err := json.Marshal(env.Body)
	if err != nil {
		return false
	}
	var update pluginPeerUpdate
	if json.Unmarshal(b, &update) != nil || !rtcSIDPattern.MatchString(update.SessionID) {
		return false
	}
	a.mu.Lock()
	s := a.peerSessions[update.SessionID]
	a.mu.Unlock()
	if s == nil {
		return true
	}
	phase := update.Session.Phase
	if phase == "" {
		phase = update.Phase
	}
	roundID := update.Session.Round.ID
	switch phase {
	case "signaling", "connecting", "active":
		s.mu.Lock()
		e := s.epoch
		if e == nil || (roundID != "" && e.roundID != roundID) || s.closed {
			used := roundID != "" && s.roundWasUsedLocked(roundID)
			s.mu.Unlock()
			return used
		}
		e.signaling = true
		if events := update.Session.EndpointEvents[s.role]; events.Completed && e.round != nil {
			e.round.completeAck = true
		}
		start := s.signalRole == "initiator" && e.ready && e.round == nil
		s.mu.Unlock()
		if start {
			go s.beginOffer(e)
		}
		return true
	case "waiting_approval", "interrupted":
		// A fresh round is authoritative only after peer_session_round_prepare.
		return true
	case "completed":
		s.mu.Lock()
		if s.epoch != nil && s.epoch.round != nil {
			s.epoch.round.completeAck = true
		}
		s.mu.Unlock()
		s.close()
		return true
	case "cancelled":
		go s.cancelFromHub()
		return true
	case "failed", "expired":
		s.close()
		return true
	}
	return false
}

func (s *pluginPeerSession) roundWasUsedLocked(roundID string) bool {
	_, ok := s.usedRounds[roundID]
	return ok
}

type pluginPeerRoundPrepare struct {
	SessionID  string `json:"session_id"`
	RoundID    string `json:"round_id"`
	RoundNo    int    `json:"round_no"`
	Side       string `json:"side"`
	SignalRole string `json:"signal_role"`
	DirectOnly bool   `json:"direct_only"`
}

func (a *Agent) handlePluginPeerRoundPrepare(env Envelope) bool {
	raw, err := json.Marshal(env.Body)
	if err != nil {
		return false
	}
	var prepare pluginPeerRoundPrepare
	if json.Unmarshal(raw, &prepare) != nil || !rtcSIDPattern.MatchString(prepare.SessionID) ||
		!rtcSIDPattern.MatchString(prepare.RoundID) || prepare.RoundNo < 2 || prepare.RoundNo > 4 || !prepare.DirectOnly ||
		(prepare.Side != "source" && prepare.Side != "target") ||
		(prepare.SignalRole != "initiator" && prepare.SignalRole != "responder") {
		return false
	}
	a.mu.Lock()
	s := a.peerSessions[prepare.SessionID]
	a.mu.Unlock()
	if s == nil {
		return false
	}
	return s.beginNextRound(prepare.RoundID, prepare.RoundNo, prepare.Side, prepare.SignalRole)
}

func (s *pluginPeerSession) beginNextRound(roundID string, roundNo int, side, signalRole string) bool {
	if !rtcSIDPattern.MatchString(roundID) {
		return false
	}
	s.mu.Lock()
	old := s.epoch
	if knownNo, used := s.usedRounds[roundID]; used {
		valid := knownNo == roundNo && side == s.role && signalRole == s.signalRole
		s.mu.Unlock()
		return valid
	}
	if s.closed || old == nil || !old.interrupted || roundNo != s.roundNo+1 ||
		roundNo > 4 || side != s.role || signalRole != s.signalRole {
		s.mu.Unlock()
		return false
	}
	s.epoch = &pluginPeerEpoch{roundID: roundID}
	s.roundNo = roundNo
	s.usedRounds[roundID] = roundNo
	s.mu.Unlock()
	stopPluginPeerEpoch(old, false)
	go s.startEpoch(roundID)
	return true
}

func (s *pluginPeerSession) interruptRound(r *pluginPeerRound, err error) {
	s.mu.Lock()
	if !s.roundCurrentLocked(r) || r.interruptSent {
		s.mu.Unlock()
		return
	}
	r.interruptSent = true
	e := r.epoch
	e.interrupted = true
	e.round = nil
	plugin := e.plugin
	e.plugin = nil
	s.mu.Unlock()
	closePluginPeerRound(r)
	if plugin != nil {
		go plugin.Abort()
	}
	s.sendEvent(e.roundID, "interrupt", "DIRECT_INTERRUPTED")
}

func (s *pluginPeerSession) failRound(r *pluginPeerRound, code string, err error) {
	s.mu.Lock()
	if !s.roundCurrentLocked(r) {
		s.mu.Unlock()
		return
	}
	e := r.epoch
	s.mu.Unlock()
	s.failEpoch(e, code, err)
}

func (s *pluginPeerSession) failEpoch(e *pluginPeerEpoch, code string, err error) {
	s.mu.Lock()
	if s.closed || s.epoch != e {
		s.mu.Unlock()
		return
	}
	// Terminal transitions are claims, not observations. Marking the session
	// closed under the same lock that validates the epoch prevents a stale
	// failure from racing a replacement round into existence.
	s.closed = true
	s.mu.Unlock()
	code = normalizePluginPeerFailureCode(code, "PLUGIN_PEER_FAILED")
	s.sendEvent(e.roundID, "fail", code)
	s.close()
}

func normalizePluginPeerFailureCode(code, fallback string) string {
	code = strings.ToUpper(strings.TrimSpace(code))
	if pluginPeerFailureCodeRE.MatchString(code) {
		return code
	}
	return fallback
}

func (s *pluginPeerSession) fail(code string, err error) {
	s.mu.Lock()
	e := s.epoch
	s.mu.Unlock()
	if e == nil {
		s.close()
		return
	}
	s.failEpoch(e, code, err)
}

func closePluginPeerRound(r *pluginPeerRound) {
	if r == nil {
		return
	}
	r.cancel()
	if r.pc != nil {
		_ = r.pc.Close()
	}
}

func stopPluginPeerEpoch(e *pluginPeerEpoch, sendCancel bool) {
	if e == nil {
		return
	}
	if e.cancel != nil {
		e.cancel()
	}
	closePluginPeerRound(e.round)
	if e.plugin != nil {
		if sendCancel {
			e.plugin.Cancel()
		} else {
			e.plugin.Abort()
		}
	}
}

func (s *pluginPeerSession) close() {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		e := s.epoch
		s.epoch = nil
		s.mu.Unlock()
		s.cancel()
		stopPluginPeerEpoch(e, false)
		s.agent.dropPluginPeer(s.sessionID, s)
	})
}

func (a *Agent) dropPluginPeer(sessionID string, s *pluginPeerSession) {
	a.mu.Lock()
	if a.peerSessions[sessionID] == s {
		delete(a.peerSessions, sessionID)
	}
	if a.pending != nil && a.pending.Peer != nil && a.pending.Kind == pendingKindPluginPeer && a.pending.Peer.session == s {
		a.pending = nil
	}
	a.mu.Unlock()
}

func (a *Agent) takePluginPeersLocked() []*pluginPeerSession {
	out := make([]*pluginPeerSession, 0, len(a.peerSessions))
	for _, session := range a.peerSessions {
		out = append(out, session)
	}
	a.peerSessions = nil
	// Delivery IDs only prove that the current in-memory session applied an
	// outbox item. Once those sessions are gone, a replay must rebuild state
	// before it is acknowledged.
	a.peerDeliveries = nil
	a.peerDeliveryOrder = nil
	if a.pending != nil && a.pending.Kind == pendingKindPluginPeer {
		a.pending = nil
	}
	return out
}

func cancelPluginPeers(sessions []*pluginPeerSession) {
	for _, session := range sessions {
		session.cancelPluginAndClose()
	}
}

func abortPluginPeers(sessions []*pluginPeerSession) {
	for _, session := range sessions {
		session.close()
	}
}
