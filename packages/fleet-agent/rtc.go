package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/pion/webrtc/v4"
)

const (
	rtcSignalMax    = 128 << 10
	rtcSessionLimit = 8
)

var rtcFingerprintPattern = regexp.MustCompile(`(?im)^a=fingerprint:sha-256\s+([0-9a-f:]+)\s*$`)
var rtcSIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type rtcSessionStatement struct {
	V          int    `json:"v"`
	Kind       string `json:"kind"`
	SID        string `json:"sid"`
	Kid        string `json:"kid"`
	DeviceID   string `json:"device_id"`
	OperatorID string `json:"operator_id"`
	OfferFP    string `json:"offer_fp"`
	AnswerFP   string `json:"answer_fp"`
	Iat        int64  `json:"iat"`
	Exp        int64  `json:"exp"`
}

type rtcAgentSession struct {
	mu         sync.Mutex
	sendMu     sync.Mutex
	sid        string
	operatorID string
	offer      string
	answer     string
	pc         *webrtc.PeerConnection
	dc         *webrtc.DataChannel
	authorized bool
	readySent  bool
	closed     bool
	claimed    map[string]struct{}
}

type rtcPendingOffer struct {
	cancel context.CancelFunc
}

func rtcFingerprint(sdp string) string {
	match := rtcFingerprintPattern.FindStringSubmatch(sdp)
	if len(match) != 2 {
		return ""
	}
	value := strings.ToLower(strings.ReplaceAll(match[1], ":", ""))
	if len(value) != 64 {
		return ""
	}
	return value
}

func rtcStunURLs(body map[string]any) []string {
	raw, _ := body["stun_urls"].([]any)
	out := make([]string, 0, len(raw))
	for _, value := range raw {
		s := strings.TrimSpace(fmt.Sprint(value))
		if strings.HasPrefix(s, "stun:") && len(s) <= 512 {
			out = append(out, s)
		}
		if len(out) == 4 {
			break
		}
	}
	return out
}

func (s *rtcAgentSession) sink() EnvelopeSink {
	return func(_ context.Context, env Envelope) error {
		payload, err := json.Marshal(env)
		if err != nil {
			return err
		}
		s.sendMu.Lock()
		defer s.sendMu.Unlock()
		s.mu.Lock()
		dc := s.dc
		ready := s.authorized && !s.closed
		s.mu.Unlock()
		if !ready || dc == nil {
			return fmt.Errorf("rtc session unavailable")
		}
		return dc.SendText(string(payload))
	}
}

func (s *rtcAgentSession) reserveClaim(corr string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.claimed == nil {
		s.claimed = make(map[string]struct{})
	}
	if _, ok := s.claimed[corr]; ok {
		return false
	}
	s.claimed[corr] = struct{}{}
	return true
}

func (s *rtcAgentSession) forgetClaim(corr string) {
	s.mu.Lock()
	delete(s.claimed, corr)
	s.mu.Unlock()
}

func (s *rtcAgentSession) close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	pc := s.pc
	s.mu.Unlock()
	if pc != nil {
		_ = pc.Close()
	}
}

func (s *rtcAgentSession) sendReady() {
	s.mu.Lock()
	dc := s.dc
	if !s.authorized || s.closed || s.readySent || dc == nil || dc.ReadyState() != webrtc.DataChannelStateOpen {
		s.mu.Unlock()
		return
	}
	s.readySent = true
	s.mu.Unlock()
	payload, err := json.Marshal(Envelope{
		V: 1, Type: "rtc_ready", ID: fmt.Sprintf("%d", time.Now().UnixNano()), T: time.Now().UnixMilli(),
		Body: map[string]any{"sid": s.sid},
	})
	if err != nil {
		return
	}
	s.sendMu.Lock()
	err = dc.SendText(string(payload))
	s.sendMu.Unlock()
	if err != nil {
		s.mu.Lock()
		s.readySent = false
		s.mu.Unlock()
	}
}

func (a *Agent) handleRTCOffer(ctx context.Context, c *websocket.Conn, env Envelope) {
	sid, _ := env.Body["sid"].(string)
	offer, _ := env.Body["offer"].(string)
	operatorID, _ := env.Body["operator_id"].(string)
	if !rtcSIDPattern.MatchString(sid) || len(operatorID) == 0 || len(operatorID) > 128 ||
		len(offer) == 0 || len(offer) > rtcSignalMax || rtcFingerprint(offer) == "" {
		return
	}
	a.mu.Lock()
	if a.authRevoked || a.ws != c {
		a.mu.Unlock()
		return
	}
	if a.rtcPending == nil {
		a.rtcPending = make(map[string]*rtcPendingOffer)
	}
	_, pending := a.rtcPending[sid]
	_, replacing := a.rtcSessions[sid]
	if pending || (!replacing && len(a.rtcSessions)+len(a.rtcPending) >= rtcSessionLimit) {
		a.log("warn", "rtc session limit reached")
		a.mu.Unlock()
		_ = wsjson.Write(ctx, c, Envelope{
			V: 1, Type: "rtc_closed", ID: fmt.Sprintf("%d", time.Now().UnixNano()), T: time.Now().UnixMilli(),
			Body: map[string]any{"sid": sid, "reason": "session_limit"},
		})
		return
	}
	offerCtx, cancel := context.WithCancel(ctx)
	reservation := &rtcPendingOffer{cancel: cancel}
	a.rtcPending[sid] = reservation
	a.mu.Unlock()
	go func() {
		defer cancel()
		session, answer, err := a.newRTCSession(offerCtx, sid, operatorID, offer, rtcStunURLs(env.Body))
		a.mu.Lock()
		current := a.rtcPending[sid] == reservation
		if current {
			delete(a.rtcPending, sid)
		}
		a.mu.Unlock()
		if !current {
			if session != nil {
				session.close()
			}
			return
		}
		if err != nil {
			a.mu.Lock()
			if !errors.Is(err, context.Canceled) {
				a.log("warn", "rtc offer failed: "+err.Error())
			}
			a.mu.Unlock()
			return
		}
		a.mu.Lock()
		if a.authRevoked || a.ws != c {
			a.mu.Unlock()
			session.close()
			return
		}
		if a.rtcSessions == nil {
			a.rtcSessions = make(map[string]*rtcAgentSession)
		}
		old := a.rtcSessions[sid]
		a.rtcSessions[sid] = session
		a.mu.Unlock()
		if old != nil {
			old.close()
		}
		if err := wsjson.Write(offerCtx, c, Envelope{
			V: 1, Type: "rtc_answer", ID: fmt.Sprintf("%d", time.Now().UnixNano()), T: time.Now().UnixMilli(),
			Body: map[string]any{"sid": sid, "answer": answer},
		}); err != nil {
			a.cancelRTCSession(sid)
		}
	}()
}

func (a *Agent) newRTCSession(ctx context.Context, sid, operatorID, offer string, stunURLs []string) (*rtcAgentSession, string, error) {
	servers := make([]webrtc.ICEServer, 0, 1)
	if len(stunURLs) > 0 {
		servers = append(servers, webrtc.ICEServer{URLs: stunURLs})
	}
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: servers})
	if err != nil {
		return nil, "", err
	}
	s := &rtcAgentSession{sid: sid, operatorID: operatorID, offer: offer, pc: pc}
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() != "fleet-v1" {
			_ = dc.Close()
			return
		}
		s.mu.Lock()
		s.dc = dc
		s.mu.Unlock()
		dc.OnOpen(s.sendReady)
		dc.OnMessage(func(message webrtc.DataChannelMessage) {
			s.mu.Lock()
			ready := s.authorized && !s.closed
			s.mu.Unlock()
			if len(message.Data) > 2<<20 {
				s.close()
				return
			}
			if !ready {
				return
			}
			var env Envelope
			if json.Unmarshal(message.Data, &env) != nil || env.V != 1 {
				return
			}
			if !a.claimRTCEnvelope(ctx, s, env.Corr) {
				s.close()
				a.dropRTCSession(sid, s)
				return
			}
			a.dispatchEnvelope(ctx, a.rtcSink(s), env)
		})
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed || state == webrtc.PeerConnectionStateDisconnected {
			a.dropRTCSession(sid, s)
		}
	})
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); err != nil {
		s.close()
		return nil, "", err
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		s.close()
		return nil, "", err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		s.close()
		return nil, "", err
	}
	select {
	case <-gathered:
	case <-ctx.Done():
		s.close()
		return nil, "", ctx.Err()
	case <-time.After(10 * time.Second):
		s.close()
		return nil, "", fmt.Errorf("ICE gathering timeout")
	}
	local := pc.LocalDescription()
	if local == nil || rtcFingerprint(local.SDP) == "" {
		s.close()
		return nil, "", fmt.Errorf("RTC answer fingerprint missing")
	}
	s.answer = local.SDP
	return s, local.SDP, nil
}

// Every direct correlation is claimed over the authenticated control socket.
// This is tiny control metadata, not business data, and lets a result fall back
// to WSS without weakening per-operator result isolation.
func (a *Agent) claimRTCEnvelope(ctx context.Context, s *rtcAgentSession, corr string) bool {
	if corr == "" || !s.reserveClaim(corr) {
		return true
	}
	relay := a.relayEnvelopeSink()
	if relay == nil {
		s.forgetClaim(corr)
		return false
	}
	err := relay(ctx, Envelope{
		V: 1, Type: "rtc_claim", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: corr, T: time.Now().UnixMilli(),
		Body: map[string]any{"sid": s.sid, "operator_id": s.operatorID},
	})
	if err != nil {
		s.forgetClaim(corr)
		return false
	}
	return true
}

func (a *Agent) rtcSink(s *rtcAgentSession) EnvelopeSink {
	direct := s.sink()
	return func(ctx context.Context, env Envelope) error {
		if err := direct(ctx, env); err == nil {
			return nil
		}
		s.close()
		a.dropRTCSession(s.sid, s)
		relay := a.relayEnvelopeSink()
		if relay == nil {
			return fmt.Errorf("rtc and websocket transports unavailable")
		}
		return relay(ctx, env)
	}
}

func (a *Agent) handleRTCTicket(env Envelope) {
	sid, _ := env.Body["sid"].(string)
	raw, ok := env.Body["statement"]
	if sid == "" || !ok {
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
	s := a.rtcSessions[sid]
	token := a.hubToken
	kid := a.authKid
	deviceID := a.deviceID
	a.mu.Unlock()
	if s == nil {
		return
	}
	var ticket rtcSessionStatement
	now := time.Now().UnixMilli()
	if verifyFleetStatement(token, signed, &ticket) != nil || ticket.V != 1 || ticket.Kind != "rtc_session" ||
		ticket.SID != sid || ticket.Kid != kid || ticket.DeviceID != deviceID || ticket.OperatorID != s.operatorID ||
		ticket.OfferFP != rtcFingerprint(s.offer) || ticket.AnswerFP != rtcFingerprint(s.answer) ||
		ticket.Iat <= 0 || ticket.Iat > now+30_000 || ticket.Exp <= ticket.Iat || ticket.Exp <= now || ticket.Exp-ticket.Iat > 60_000 {
		s.close()
		a.dropRTCSession(sid, s)
		return
	}
	s.mu.Lock()
	s.authorized = true
	s.mu.Unlock()
	s.sendReady()
	a.mu.Lock()
	a.log("info", "rtc direct ready sid="+sid)
	a.mu.Unlock()
}

func (a *Agent) dropRTCSession(sid string, expected *rtcAgentSession) {
	removed := false
	a.mu.Lock()
	if a.rtcSessions[sid] == expected {
		delete(a.rtcSessions, sid)
		removed = true
	}
	a.mu.Unlock()
	if removed {
		go expected.close()
	}
}

func (a *Agent) cancelRTCSession(sid string) {
	a.mu.Lock()
	s := a.rtcSessions[sid]
	delete(a.rtcSessions, sid)
	pending := a.rtcPending[sid]
	delete(a.rtcPending, sid)
	a.mu.Unlock()
	if pending != nil {
		pending.cancel()
	}
	if s != nil {
		s.close()
	}
}

func (a *Agent) takeRTCSessionsLocked() []*rtcAgentSession {
	out := make([]*rtcAgentSession, 0, len(a.rtcSessions))
	for _, s := range a.rtcSessions {
		out = append(out, s)
	}
	a.rtcSessions = nil
	for _, pending := range a.rtcPending {
		pending.cancel()
	}
	a.rtcPending = nil
	return out
}

func closeRTCSessions(sessions []*rtcAgentSession) {
	for _, s := range sessions {
		s.close()
	}
}
