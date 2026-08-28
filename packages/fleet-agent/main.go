package main

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/TITOCHAN2023/fleetForAgent/internal/desktop"
	"github.com/TITOCHAN2023/fleetForAgent/internal/keepalive"
	"github.com/TITOCHAN2023/fleetForAgent/internal/pane"
	"github.com/TITOCHAN2023/fleetForAgent/internal/policy"
	"github.com/TITOCHAN2023/fleetForAgent/internal/tray"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

var agentVersion = "0.6.0"

//go:embed ui/index.html
var uiHTML []byte

type Permit string

const (
	PermitOff   Permit = "off"
	PermitAsk   Permit = "ask"
	PermitAllow Permit = "allow"
)

type LogLine struct {
	ID    string `json:"id"`
	T     int64  `json:"t"`
	Level string `json:"level"`
	Msg   string `json:"msg"`
}

const (
	pendingKindRun  = "run"
	pendingKindType = "type"
)

type permitVerdict int

const (
	permitProceed permitVerdict = iota
	permitRefuse
	permitAsk
)

type Pending struct {
	Corr        string                     `json:"corr"`
	Command     string                     `json:"command"`
	Requested   int64                      `json:"requestedAt"`
	Kind        string                     `json:"kind,omitempty"`
	Fingerprint string                     `json:"-"`
	PaneID      string                     `json:"-"`
	Keys        string                     `json:"-"`
	Key         string                     `json:"-"`
	Plugin      *pluginRequest             `json:"-"`
	Peer        *pluginPeerPendingApproval `json:"-"`
	Sink        EnvelopeSink               `json:"-"`
}

type Envelope struct {
	V    int            `json:"v"`
	Type string         `json:"type"`
	ID   string         `json:"id"`
	Corr string         `json:"corr,omitempty"`
	T    int64          `json:"t"`
	Body map[string]any `json:"body"`
}

// EnvelopeSink is the only business-response transport boundary. WSS and RTC
// both carry the exact same Envelope; handlers must not know which one won.
type EnvelopeSink func(context.Context, Envelope) error

func wsEnvelopeSink(c *websocket.Conn) EnvelopeSink {
	return func(ctx context.Context, env Envelope) error {
		return wsjson.Write(ctx, c, env)
	}
}

// relayEnvelopeSink returns the currently authenticated control transport.
// relaySink is test-only injection; production always uses the live WSS.
func (a *Agent) relayEnvelopeSink() EnvelopeSink {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.authRevoked {
		return nil
	}
	if a.relaySink != nil {
		return a.relaySink
	}
	if a.ws == nil {
		return nil
	}
	return wsEnvelopeSink(a.ws)
}

type State struct {
	Enabled    bool       `json:"enabled"`
	Permit     Permit     `json:"permit"`
	HubInput   string     `json:"hubInput"`
	HubToken   string     `json:"hubToken"`
	DeviceID   string     `json:"deviceId"`
	AgentVer   string     `json:"agentVer"`
	WSS        string     `json:"wss"`
	Conn       string     `json:"conn"`
	Error      string     `json:"error"`
	Logs       []LogLine  `json:"logs"`
	Pending    *Pending   `json:"pending"`
	AutoUpdate bool       `json:"autoUpdate"`
	Update     updateInfo `json:"update"`
}

type Agent struct {
	mu                  sync.Mutex
	enabled             bool
	permit              Permit
	hubInput            string
	hubToken            string
	authKid             string
	authRevoked         bool
	deviceID            string
	wss                 string
	conn                string
	err                 string
	logs                []LogLine
	pending             *Pending
	desktopPending      *Pending
	desktopShotGranted  bool
	desktopInputGranted bool
	desktopDeniedOnce   bool
	lastFrame           *desktop.DesktopFrame
	lastDigest          string
	shotTimes           []time.Time
	actTimes            []time.Time
	backend             desktop.Backend
	osBackend           desktop.Backend
	seq                 int
	ws                  *websocket.Conn
	cancel              context.CancelFunc
	cfgPath             string
	panes               *pane.Supervisor
	paneSinks           map[string]EnvelopeSink
	rtcSessions         map[string]*rtcAgentSession
	rtcPending          map[string]*rtcPendingOffer
	peerSessions        map[string]*pluginPeerSession
	peerDeliveries      map[string]struct{}
	peerDeliveryOrder   []string
	hb                  time.Duration
	restarting          bool
	autoUpdate          bool
	updateSig           versionSignal
	policyBlocked       func(string) bool
	relaySink           EnvelopeSink
}

func (a *Agent) log(level, msg string) {
	a.seq++
	line := LogLine{ID: fmt.Sprintf("l%d", a.seq), T: time.Now().UnixMilli(), Level: level, Msg: msg}
	a.logs = append([]LogLine{line}, a.logs...)
	if len(a.logs) > 200 {
		a.logs = a.logs[:200]
	}
	log.Printf("%s %s", level, msg)
}

func (a *Agent) snapshot() State {
	logs := make([]LogLine, len(a.logs))
	copy(logs, a.logs)
	pending := a.pending
	if a.desktopPending != nil {
		pending = a.desktopPending
	}
	return State{
		Enabled:    a.enabled,
		Permit:     a.permit,
		HubInput:   a.hubInput,
		HubToken:   a.hubToken,
		DeviceID:   a.deviceID,
		AgentVer:   agentVersion,
		WSS:        a.wss,
		Conn:       a.conn,
		Error:      a.err,
		Logs:       logs,
		Pending:    pending,
		AutoUpdate: a.autoUpdate,
		Update:     updateStatus(),
	}
}

func (a *Agent) publicSnapshot() State {
	s := a.snapshot()
	s.HubToken = hubTokenPublic(s.HubToken)
	return s
}

// inputVerdict is called with a.mu held.
func (a *Agent) inputVerdict() (permitVerdict, string) {
	if !a.enabled || a.permit == PermitOff {
		return permitRefuse, "fleet: permit=off — 本机不允许执行"
	}
	if a.permit == PermitAllow {
		return permitProceed, ""
	}
	if a.pending != nil {
		return permitRefuse, "fleet: another command is waiting for consent"
	}
	return permitAsk, ""
}

func (a *Agent) commandBlocked(command string) bool {
	if a.policyBlocked != nil {
		return a.policyBlocked(command)
	}
	return policy.Blocked(command)
}

func (a *Agent) save() {
	b, _ := json.MarshalIndent(map[string]any{
		"enabled":    a.enabled,
		"permit":     a.permit,
		"hubInput":   a.hubInput,
		"hubToken":   a.hubToken,
		"deviceId":   a.deviceID,
		"autoUpdate": a.autoUpdate,
	}, "", "  ")
	_ = os.WriteFile(a.cfgPath, b, 0o600)
}

func (a *Agent) load() {
	b, err := os.ReadFile(a.cfgPath)
	if err != nil {
		a.permit = PermitAsk
		a.deviceID = newDeviceID()
		a.autoUpdate = true
		a.applyEnv(false)
		a.save()
		return
	}
	var cfg struct {
		Enabled    bool   `json:"enabled"`
		Permit     Permit `json:"permit"`
		HubInput   string `json:"hubInput"`
		HubToken   string `json:"hubToken"`
		DeviceID   string `json:"deviceId"`
		AutoUpdate *bool  `json:"autoUpdate"`
	}
	a.autoUpdate = true
	if json.Unmarshal(b, &cfg) == nil {
		a.enabled = cfg.Enabled
		a.permit = cfg.Permit
		a.hubInput = cfg.HubInput
		a.hubToken = cfg.HubToken
		a.deviceID = cfg.DeviceID
		if cfg.AutoUpdate != nil {
			a.autoUpdate = *cfg.AutoUpdate
		}
	}
	if a.permit == "" {
		a.permit = PermitAsk
	}
	if a.deviceID == "" {
		a.deviceID = newDeviceID()
	}
	a.applyEnv(true)
	a.save()
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}

func (a *Agent) applyEnv(hadCfg bool) {
	if v := firstNonEmpty(os.Getenv("FLEET_URL"), os.Getenv("FLEET_HUB")); v != "" {
		a.hubInput = v
	}
	if v := firstNonEmpty(os.Getenv("FLEET_TOKEN"), os.Getenv("FLEET_HUB_TOKEN")); v != "" {
		a.hubToken = v
	}
	switch strings.ToLower(strings.TrimSpace(os.Getenv("FLEET_ENABLED"))) {
	case "1", "true", "yes", "on":
		a.enabled = true
	case "0", "false", "no", "off":
		a.enabled = false
	default:
		if runtime.GOOS == "linux" && !hadCfg && strings.TrimSpace(a.hubInput) != "" {
			a.enabled = true
		}
	}
	switch strings.ToLower(strings.TrimSpace(os.Getenv("FLEET_AUTO_UPDATE"))) {
	case "1", "true", "yes", "on":
		a.autoUpdate = true
	case "0", "false", "no", "off":
		a.autoUpdate = false
	}
}

func normalizeHub(raw string) (wss string, err error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", fmt.Errorf("Enter the hub address")
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	s = strings.Replace(s, "https://", "wss://", 1)
	s = strings.Replace(s, "http://", "ws://", 1)
	if !strings.Contains(strings.TrimPrefix(strings.TrimPrefix(s, "wss://"), "ws://"), "/") {
		s += "/v1/device"
	}
	return s, nil
}

func (a *Agent) setEnabled(on bool) {
	a.mu.Lock()
	a.enabled = on
	hub := a.hubInput
	if !on {
		a.disconnectLocked("本机开关已关闭")
	}
	a.log("info", map[bool]string{true: "agent enabled", false: "agent disabled"}[on])
	a.save()
	a.mu.Unlock()
	keepalive.Set(on)
	if on && strings.TrimSpace(hub) != "" {
		go func() { _ = a.connect(hub) }()
	}
	a.pushUI()
}

func (a *Agent) setPermit(p Permit) {
	var peerSessions []*pluginPeerSession
	a.mu.Lock()
	if p == PermitOff || p == PermitAsk || p == PermitAllow {
		a.permit = p
		a.desktopShotGranted = false
		a.desktopInputGranted = false
		a.desktopPending = nil
		a.lastFrame = nil
		a.lastDigest = ""
		a.log("info", "permit → "+string(p))
		if p == PermitOff {
			peerSessions = a.takePluginPeersLocked()
		}
		a.save()
	}
	ws := a.ws
	a.mu.Unlock()
	if len(peerSessions) > 0 {
		cancelPluginPeers(peerSessions)
	}
	a.pushUI()
	if ws != nil {
		_ = wsjson.Write(context.Background(), ws, Envelope{
			V: 1, Type: "ping", ID: fmt.Sprintf("%d", time.Now().UnixNano()), T: time.Now().UnixMilli(),
			Body: map[string]any{"agent_ver": agentVersion, "permit": string(p), "caps": agentCaps()},
		})
	}
}

func (a *Agent) pushUI() {
	a.mu.Lock()
	s := a.publicSnapshot()
	a.mu.Unlock()
	tray.Update(traySnap(s))
}

func (a *Agent) disconnectLocked(reason string) {
	if a.cancel != nil {
		a.cancel()
		a.cancel = nil
	}
	if a.ws != nil {
		_ = a.ws.Close(websocket.StatusNormalClosure, reason)
		a.ws = nil
	}
	a.pending = nil
	sessions := a.takeRTCSessionsLocked()
	peerSessions := a.takePluginPeersLocked()
	if len(sessions) > 0 {
		go closeRTCSessions(sessions)
	}
	if len(peerSessions) > 0 {
		go cancelPluginPeers(peerSessions)
	}
	a.clearDesktopSessionLocked()
	a.conn = "offline"
	a.log("warn", reason)
}

func (a *Agent) clearDesktopSessionLocked() {
	a.desktopPending = nil
	a.desktopShotGranted = false
	a.desktopInputGranted = false
	a.lastFrame = nil
	a.lastDigest = ""
}

func (a *Agent) connect(hub string) error {
	a.mu.Lock()
	if !a.enabled {
		a.mu.Unlock()
		return fmt.Errorf("Turn on this computer first")
	}
	if a.authRevoked {
		a.mu.Unlock()
		return fmt.Errorf("Hub token was reset or revoked. Paste the new token to reconnect.")
	}
	wss, err := normalizeHub(hub)
	if err != nil {
		a.err = err.Error()
		a.conn = "error"
		a.log("error", a.err)
		a.mu.Unlock()
		return err
	}
	a.hubInput = hub
	a.wss = wss
	a.conn = "connecting"
	a.err = ""
	if a.deviceID == "" {
		a.deviceID = newDeviceID()
	}
	a.log("info", "connecting "+wss)
	if a.cancel != nil {
		a.cancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.cancel = cancel
	tok := a.hubToken
	if tok == "" {
		tok = os.Getenv("FLEET_HUB_TOKEN")
	}
	deviceID := a.deviceID
	a.mu.Unlock()
	claims, _ := verifyTokenV1(tok)

	headers := map[string][]string{
		"X-Fleet-Proto": {"1"},
		"X-Device-Id":   {deviceID},
		"X-Device-Name": {deviceName()},
		"X-Device-Os":   {osKind()},
	}
	auth, err := highSecAuthorization(ctx, wss, tok)
	if err != nil {
		a.mu.Lock()
		if strings.Contains(err.Error(), "HIGH_SEC:") {
			a.conn = "auth_failed"
		} else {
			a.conn = "error"
		}
		a.err = err.Error()
		a.log("error", a.err)
		a.save()
		a.mu.Unlock()
		a.pushUI()
		return err
	}
	if auth != "" {
		headers["Authorization"] = []string{auth}
	}

	c, _, err := websocket.Dial(ctx, wss, &websocket.DialOptions{HTTPHeader: headers})
	a.mu.Lock()
	if err != nil {
		a.conn = "error"
		a.err = err.Error()
		a.log("error", a.err)
		a.save()
		a.mu.Unlock()
		a.pushUI()
		return err
	}
	c.SetReadLimit(256 << 10)
	a.ws = c
	if claims != nil {
		a.authKid = claims.Kid
	} else {
		a.authKid = ""
	}
	a.authRevoked = false
	a.conn = "online"
	a.log("info", "online id="+deviceID)
	a.save()
	hello := Envelope{V: 1, Type: "hello", ID: fmt.Sprintf("%d", time.Now().UnixNano()), T: time.Now().UnixMilli(), Body: map[string]any{
		"os":        osKind(),
		"arch":      runtime.GOARCH,
		"hostname":  deviceName(),
		"caps":      agentCaps(),
		"agent_ver": agentVersion,
		"permit":    string(a.permit),
		"egress":    "internet",
		"device_id": deviceID,
	}}
	a.mu.Unlock()
	a.pushUI()
	_ = wsjson.Write(ctx, c, hello)
	go a.readLoop(ctx, c)
	go a.coalesceLoop(ctx, c)
	go a.heartbeatLoop(ctx, c)
	go a.autoUpdateLoop(ctx)
	return nil
}

func (a *Agent) maintain() {
	backoff := time.Second
	for {
		time.Sleep(500 * time.Millisecond)
		a.mu.Lock()
		want := a.wantsReconnectLocked()
		hub := a.hubInput
		a.mu.Unlock()
		if !want {
			backoff = time.Second
			continue
		}
		time.Sleep(backoff)
		a.mu.Lock()
		want = a.wantsReconnectLocked()
		hub = a.hubInput
		a.mu.Unlock()
		if !want {
			continue
		}
		err := a.connect(hub)
		if err != nil && backoff < 20*time.Second {
			backoff *= 2
			continue
		}
		backoff = time.Second
	}
}

func osKind() string {
	if runtime.GOOS == "darwin" || runtime.GOOS == "windows" {
		return runtime.GOOS
	}
	return "linux"
}

func newDeviceID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func hostname() string {
	h, _ := os.Hostname()
	if h == "" {
		return "fleet-agent"
	}
	return h
}

// deviceName is X-Device-Name / hello hostname. FLEET_NAME overrides so a test
// agent is not listed as a second copy of the machine hostname.
func deviceName() string {
	if v := strings.TrimSpace(os.Getenv("FLEET_NAME")); v != "" {
		return v
	}
	return hostname()
}

func agentCaps() []string {
	caps := []string{"shell", "pane", "plugins", "rtc_v1", "plugin_peer_session_v1"}
	if runtime.GOOS != "windows" {
		caps = append(caps, "live_shell")
	}
	if desktop.Supported() {
		caps = append(caps, "computer_use")
	}
	return caps
}

func (a *Agent) readLoop(ctx context.Context, c *websocket.Conn) {
	defer func() {
		var sessions []*rtcAgentSession
		var peerSessions []*pluginPeerSession
		a.mu.Lock()
		if a.ws == c {
			a.ws = nil
			if a.conn != "auth_failed" {
				a.conn = "offline"
			}
			a.paneSinks = nil
			a.pending = nil
			sessions = a.takeRTCSessionsLocked()
			peerSessions = a.takePluginPeersLocked()
			a.clearDesktopSessionLocked()
			a.log("warn", "socket closed")
		}
		a.mu.Unlock()
		closeRTCSessions(sessions)
		abortPluginPeers(peerSessions)
		a.pushUI()
	}()
	for {
		var env Envelope
		if err := wsjson.Read(ctx, c, &env); err != nil {
			return
		}
		switch env.Type {
		case "hello_ok":
			a.noteHubUpdate(env.Body)
		case "pong":
			a.noteHubUpdate(env.Body)
		case "ask_heartbeat":
			a.noteHubUpdate(env.Body)
			if !a.sendPresence(ctx, c) {
				return
			}
		case "ping":
			a.noteHubUpdate(env.Body)
			_ = wsjson.Write(ctx, c, Envelope{V: 1, Type: "pong", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: env.ID, T: time.Now().UnixMilli(), Body: map[string]any{}})
		case "auth_revoked":
			if a.handleAuthRevoked(c, env) {
				return
			}
		case "rtc_offer":
			a.handleRTCOffer(ctx, c, env)
		case "rtc_ticket":
			a.handleRTCTicket(env)
		case "rtc_cancel":
			sid, _ := env.Body["sid"].(string)
			a.cancelRTCSession(sid)
		case "peer_session_prepare", "peer_session_round_prepare", "peer_session_signal", "peer_session_ticket":
			a.handlePluginPeerDelivery(ctx, wsEnvelopeSink(c), env)
		case "peer_session_update":
			if _, delivered := env.Body["delivery_id"]; delivered {
				a.handlePluginPeerDelivery(ctx, wsEnvelopeSink(c), env)
			} else {
				a.handlePluginPeerUpdate(env)
			}
		default:
			a.dispatchEnvelope(ctx, wsEnvelopeSink(c), env)
		}
	}
}

func (a *Agent) handleAuthRevoked(c *websocket.Conn, env Envelope) bool {
	kid, _ := env.Body["kid"].(string)
	rawStatement, ok := env.Body["statement"]
	if !ok || strings.TrimSpace(kid) == "" {
		return false
	}
	b, err := json.Marshal(rawStatement)
	if err != nil {
		return false
	}
	var signed signedFleetStatement
	if json.Unmarshal(b, &signed) != nil {
		return false
	}
	a.mu.Lock()
	token := a.hubToken
	currentKid := a.authKid
	a.mu.Unlock()
	var statement authRevokedStatement
	if verifyFleetStatement(token, signed, &statement) != nil ||
		statement.V != 1 || statement.Kind != "auth_revoked" || statement.Kid != kid ||
		statement.Kid != currentKid || statement.At <= 0 || statement.Reason != "token_reset" {
		return false
	}
	a.mu.Lock()
	if a.hubToken != token || a.authKid != currentKid {
		a.mu.Unlock()
		return false
	}
	a.authRevoked = true
	a.pending = nil
	a.paneSinks = nil
	sessions := a.takeRTCSessionsLocked()
	peerSessions := a.takePluginPeersLocked()
	a.clearDesktopSessionLocked()
	a.conn = "auth_failed"
	a.err = "Hub token was reset or revoked. Paste the new token to reconnect."
	a.log("error", a.err)
	if a.cancel != nil {
		a.cancel()
		a.cancel = nil
	}
	if a.ws == c {
		a.ws = nil
	}
	a.save()
	a.mu.Unlock()
	closeRTCSessions(sessions)
	cancelPluginPeers(peerSessions)
	if c != nil {
		_ = c.Close(websocket.StatusPolicyViolation, "token reset")
	}
	a.pushUI()
	return true
}

// dispatchEnvelope is shared by every data transport. Keep business message
// handling here so adding RTC cannot fork shell, pane, desktop, or plugin rules.
func (a *Agent) dispatchEnvelope(ctx context.Context, sink EnvelopeSink, env Envelope) {
	switch env.Type {
	case "run":
		cmd, _ := env.Body["command"].(string)
		go a.handleRun(ctx, sink, env.Corr, cmd, envelopeFingerprint(env.Body))
	case "type":
		keys, _ := env.Body["keys"].(string)
		key, _ := env.Body["key"].(string)
		id, _ := env.Body["pane_id"].(string)
		if id == "" {
			id, _ = env.Body["corr"].(string)
		}
		go a.handleType(ctx, sink, env.Corr, id, keys, key, envelopeFingerprint(env.Body))
	case "read_screen":
		id, _ := env.Body["pane_id"].(string)
		if id == "" {
			id, _ = env.Body["corr"].(string)
		}
		a.handleScreen(ctx, sink, env.Corr, id, envelopeFingerprint(env.Body))
	case "list_panes":
		a.mu.Lock()
		list := a.panes.List()
		a.mu.Unlock()
		_ = sink(ctx, Envelope{V: 1, Type: "panes", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: env.Corr, T: time.Now().UnixMilli(), Body: map[string]any{"panes": list}})
	case "desktop_screenshot":
		go a.handleDesktopScreenshot(ctx, sink, env)
	case "desktop_action":
		go a.handleDesktopAction(ctx, sink, env)
	case "plugin":
		a.handlePlugin(ctx, sink, env)
	}
}

func envelopeFingerprint(body map[string]any) string {
	if body == nil {
		return ""
	}
	s, _ := body["fingerprint"].(string)
	return strings.TrimSpace(s)
}

func (a *Agent) handleRun(ctx context.Context, sink EnvelopeSink, corr, cmd, fingerprint string) {
	a.mu.Lock()
	v, msg := a.inputVerdict()
	if v == permitRefuse {
		a.log("warn", "refused: "+cmd)
		code := 126
		if strings.Contains(msg, "waiting for consent") {
			code = 1
		}
		a.mu.Unlock()
		_ = sink(ctx, resultEnv(corr, false, code, "", msg))
		return
	}
	if a.commandBlocked(cmd) {
		a.log("error", "blocked destructive: "+cmd)
		a.mu.Unlock()
		_ = sink(ctx, resultEnv(corr, false, 126, "", "fleet: refused by device policy"))
		return
	}
	if v == permitAsk {
		a.pending = &Pending{Kind: pendingKindRun, Corr: corr, Command: cmd, Requested: time.Now().UnixMilli(), Fingerprint: fingerprint, Sink: sink}
		a.log("warn", "waiting consent: "+cmd)
		a.mu.Unlock()
		notifyConsent(cmd)
		a.pushUI()
		return
	}
	a.mu.Unlock()
	a.spawnPane(ctx, sink, corr, cmd, fingerprint)
}

func (a *Agent) spawnPane(ctx context.Context, sink EnvelopeSink, corr, cmd, fingerprint string) {
	a.mu.Lock()
	if a.panes == nil {
		a.panes = pane.NewSupervisor()
	}
	sup := a.panes
	a.mu.Unlock()
	p, err := sup.SpawnFor(fingerprint, corr, cmd)
	if err != nil {
		_ = sink(ctx, resultEnv(corr, false, 1, "", err.Error()))
		return
	}
	a.mu.Lock()
	if a.paneSinks == nil {
		a.paneSinks = make(map[string]EnvelopeSink)
	}
	a.paneSinks[corr] = sink
	a.log("info", "pane accepted "+p.ID())
	a.mu.Unlock()
	_ = sink(ctx, Envelope{V: 1, Type: "accepted", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: corr, T: time.Now().UnixMilli(), Body: map[string]any{"pane_id": p.ID(), "status": "running"}})
	go func() {
		defer func() {
			a.mu.Lock()
			delete(a.paneSinks, corr)
			a.mu.Unlock()
		}()
		for {
			done, code := p.Finished()
			if done {
				stdout, stderr := p.ResultText()
				_ = sink(ctx, resultEnv(corr, code == 0, code, stdout, stderr))
				a.mu.Lock()
				a.log("info", fmt.Sprintf("result %d: %s", code, cmd))
				a.mu.Unlock()
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(50 * time.Millisecond):
			}
		}
	}()
}

func clip(s string, n int) string { return tray.Clip(s, n) }

func typeConsentText(keys, key string) string {
	if s := strings.TrimSpace(key); s != "" {
		return "type " + s
	}
	return "type " + clip(keys, 80)
}

func typedEnv(corr string, ok bool, errMsg string) Envelope {
	return Envelope{V: 1, Type: "typed", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: corr, T: time.Now().UnixMilli(), Body: map[string]any{"ok": ok, "error": errMsg}}
}

func (a *Agent) handleType(ctx context.Context, sink EnvelopeSink, corr, id, keys, key, fingerprint string) {
	a.mu.Lock()
	v, msg := a.inputVerdict()
	if v == permitRefuse {
		a.log("warn", "refused type")
		a.mu.Unlock()
		_ = sink(ctx, typedEnv(corr, false, msg))
		return
	}
	if v == permitAsk {
		label := typeConsentText(keys, key)
		a.pending = &Pending{
			Kind: pendingKindType, Corr: corr, Command: label, Requested: time.Now().UnixMilli(),
			Fingerprint: fingerprint, PaneID: id, Keys: keys, Key: key, Sink: sink,
		}
		a.log("warn", "waiting consent: "+label)
		a.mu.Unlock()
		notifyConsent(label)
		a.pushUI()
		return
	}
	a.mu.Unlock()
	a.deliverType(ctx, sink, corr, id, keys, key, fingerprint)
}

func (a *Agent) deliverType(ctx context.Context, sink EnvelopeSink, corr, id, keys, key, fingerprint string) {
	a.mu.Lock()
	sup := a.panes
	a.mu.Unlock()
	if sup == nil {
		_ = sink(ctx, typedEnv(corr, false, "no pane"))
		return
	}
	p := sup.GetFor(fingerprint, id)
	if p == nil {
		_ = sink(ctx, typedEnv(corr, false, "pane gone"))
		return
	}
	err := p.TypeInput(keys, key)
	ok := err == nil
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	_ = sink(ctx, typedEnv(corr, ok, msg))
}

func (a *Agent) handleScreen(ctx context.Context, sink EnvelopeSink, corr, id string, fingerprint string) {
	a.mu.Lock()
	sup := a.panes
	a.mu.Unlock()
	if sup == nil {
		_ = sink(ctx, Envelope{V: 1, Type: "screen", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: corr, T: time.Now().UnixMilli(), Body: map[string]any{"text": "", "running": false}})
		return
	}
	p := sup.GetFor(fingerprint, id)
	if p == nil {
		_ = sink(ctx, Envelope{V: 1, Type: "screen", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: corr, T: time.Now().UnixMilli(), Body: map[string]any{"text": "", "running": false}})
		return
	}
	text, running, code, seq, row, col := sup.PaneSnapshot(p)
	_ = sink(ctx, Envelope{V: 1, Type: "screen", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: corr, T: time.Now().UnixMilli(), Body: map[string]any{
		"pane_id": p.ID(), "text": text, "running": running, "exit_code": code, "seq": seq,
		"cursor_row": row, "cursor_col": col,
	}})
}

func (a *Agent) coalesceLoop(ctx context.Context, c *websocket.Conn) {
	defaultSink := wsEnvelopeSink(c)
	tick := time.NewTicker(pane.ScreenInterval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			a.mu.Lock()
			sup := a.panes
			a.mu.Unlock()
			if sup == nil {
				continue
			}
			p := sup.TakeDirty()
			if p == nil {
				continue
			}
			text, running, code, seq, row, col := sup.PaneSnapshot(p)
			a.mu.Lock()
			sink := a.paneSinks[p.Corr()]
			a.mu.Unlock()
			if sink == nil {
				sink = defaultSink
			}
			_ = sink(ctx, Envelope{V: 1, Type: "screen", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: p.Corr(), T: time.Now().UnixMilli(), Body: map[string]any{
				"pane_id": p.ID(), "text": text, "running": running, "exit_code": code, "seq": seq,
				"cursor_row": row, "cursor_col": col,
			}})
		}
	}
}

func resultEnv(corr string, ok bool, code int, stdout, stderr string) Envelope {
	return Envelope{V: 1, Type: "result", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: corr, T: time.Now().UnixMilli(), Body: map[string]any{"ok": ok, "exit_code": code, "error": stderr, "stdout": stdout}}
}

func runCmd(command string) (string, string, int) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "cmd", "/C", command)
	} else {
		cmd = exec.CommandContext(ctx, "/bin/sh", "-c", command)
	}
	out, err := cmd.CombinedOutput()
	code := 0
	if err != nil {
		code = 1
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		}
	}
	return string(out), "", code
}

func (a *Agent) approve() {
	a.mu.Lock()
	if a.desktopPending != nil {
		p := a.desktopPending
		a.desktopPending = nil
		if p.Kind == pendingKindDesktopInput {
			a.desktopInputGranted = true
		} else {
			a.desktopShotGranted = true
		}
		a.log("info", "approved: "+p.Command)
		a.mu.Unlock()
		a.pushUI()
		return
	}
	p := a.pending
	a.pending = nil
	a.mu.Unlock()
	if p == nil || p.Sink == nil {
		return
	}
	if p.Kind == pendingKindPlugin && p.Plugin != nil {
		_ = p.Sink(context.Background(), pluginAcceptedEnv(p.Corr, "running"))
		go a.executePlugin(context.Background(), p.Sink, p.Corr, *p.Plugin)
	} else if p.Peer != nil {
		go p.Peer.approve()
	} else if p.Kind == pendingKindType {
		go a.deliverType(context.Background(), p.Sink, p.Corr, p.PaneID, p.Keys, p.Key, p.Fingerprint)
	} else {
		go a.spawnPane(context.Background(), p.Sink, p.Corr, p.Command, p.Fingerprint)
	}
	a.mu.Lock()
	a.log("info", "approved: "+p.Command)
	a.mu.Unlock()
	a.pushUI()
}

func (a *Agent) deny() {
	a.mu.Lock()
	if a.desktopPending != nil {
		p := a.desktopPending
		a.desktopPending = nil
		a.desktopDeniedOnce = true
		a.log("warn", "denied: "+p.Command)
		a.mu.Unlock()
		a.pushUI()
		return
	}
	p := a.pending
	a.pending = nil
	a.mu.Unlock()
	if p == nil || p.Sink == nil {
		return
	}
	if p.Peer != nil {
		p.Peer.deny(errors.New("fleet: denied at the machine"))
	} else if p.Kind == pendingKindPlugin {
		_ = p.Sink(context.Background(), pluginResultEnv(p.Corr, nil, errors.New("fleet: denied at the machine")))
	} else if p.Kind == pendingKindType {
		_ = p.Sink(context.Background(), typedEnv(p.Corr, false, "fleet: denied at the machine"))
	} else {
		_ = p.Sink(context.Background(), resultEnv(p.Corr, false, 1, "", "fleet: denied at the machine"))
	}
	a.mu.Lock()
	a.log("warn", "denied: "+p.Command)
	a.mu.Unlock()
	a.pushUI()
}

func listenSettings(addr string) (net.Listener, error) {
	var ln net.Listener
	var err error
	for i := 0; i < 25; i++ {
		ln, err = net.Listen("tcp", addr)
		if err == nil {
			return ln, nil
		}
		time.Sleep(80 * time.Millisecond)
	}
	return nil, err
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func main() {
	args := os.Args[1:]
	if len(args) > 0 && args[0] != "--daemon" && args[0] != "daemon" {
		os.Exit(runCLI(args))
	}
	maybeDaemonize()
	maybePromoteBinary()

	dir := fleetHome()
	_ = os.MkdirAll(dir, 0o700)
	agent := &Agent{permit: PermitAsk, autoUpdate: true, conn: "offline", cfgPath: configPath(), panes: pane.NewSupervisor()}
	agent.load()

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/html; charset=utf-8")
		_, _ = w.Write(uiHTML)
	})
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		agent.mu.Lock()
		s := agent.publicSnapshot()
		agent.mu.Unlock()
		writeJSON(w, s)
	})
	mux.HandleFunc("/api/enabled", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Enabled bool `json:"enabled"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body)
		agent.setEnabled(body.Enabled)
		agent.mu.Lock()
		s := agent.publicSnapshot()
		agent.mu.Unlock()
		writeJSON(w, s)
	})
	mux.HandleFunc("/api/permit", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Permit Permit `json:"permit"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body)
		agent.setPermit(body.Permit)
		agent.mu.Lock()
		s := agent.publicSnapshot()
		agent.mu.Unlock()
		writeJSON(w, s)
	})
	mux.HandleFunc("/api/connect", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Hub   string `json:"hub"`
			Token string `json:"token"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body)
		agent.mu.Lock()
		if body.Token != "" && body.Token != hubTokenPublic(agent.hubToken) && body.Token != "set" {
			changed := strings.TrimSpace(body.Token) != strings.TrimSpace(agent.hubToken)
			agent.hubToken = body.Token
			if changed {
				agent.authRevoked = false
				agent.authKid = ""
				agent.err = ""
				if agent.conn == "auth_failed" {
					agent.conn = "offline"
				}
			}
		}
		hub := body.Hub
		if strings.TrimSpace(hub) == "" {
			hub = agent.hubInput
		}
		agent.save()
		agent.mu.Unlock()
		go func() { _ = agent.connect(hub) }()
		time.Sleep(80 * time.Millisecond)
		agent.mu.Lock()
		s := agent.publicSnapshot()
		agent.mu.Unlock()
		writeJSON(w, s)
	})
	mux.HandleFunc("/api/approve", func(w http.ResponseWriter, r *http.Request) {
		agent.approve()
		agent.mu.Lock()
		s := agent.publicSnapshot()
		agent.mu.Unlock()
		writeJSON(w, s)
	})
	mux.HandleFunc("/api/deny", func(w http.ResponseWriter, r *http.Request) {
		agent.deny()
		agent.mu.Lock()
		s := agent.publicSnapshot()
		agent.mu.Unlock()
		writeJSON(w, s)
	})
	mux.HandleFunc("/api/quit", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true})
		go func() {
			time.Sleep(80 * time.Millisecond)
			agent.mu.Lock()
			agent.disconnectLocked("quit")
			agent.mu.Unlock()
			keepalive.Set(false)
			tray.RequestQuit()
		}()
	})
	mux.HandleFunc("/api/restart", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true, "mode": restartModeSpawnThenExit, "addr": settingsAddr()})
		go func() {
			time.Sleep(80 * time.Millisecond)
			if err := agent.requestRestart(); err != nil {
				agent.mu.Lock()
				agent.log("error", "restart: "+err.Error())
				agent.mu.Unlock()
				agent.pushUI()
			}
		}()
	})
	mux.HandleFunc("/api/update", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			if r.URL.Query().Get("refresh") == "1" {
				info, err := checkUpdate()
				if err != nil {
					writeJSON(w, info)
					return
				}
				writeJSON(w, info)
				return
			}
			writeJSON(w, updateStatus())
			return
		}
		var req updateRequest
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req)
		if err := startUpdate(agent, req); err != nil {
			writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"ok": true, "started": true})
	})
	mux.HandleFunc("/api/autoupdate", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			AutoUpdate bool `json:"autoUpdate"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body)
		agent.setAutoUpdate(body.AutoUpdate)
		agent.mu.Lock()
		s := agent.publicSnapshot()
		agent.mu.Unlock()
		writeJSON(w, s)
	})
	mux.HandleFunc("/api/rollback", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true})
		go func() {
			time.Sleep(80 * time.Millisecond)
			if err := agent.requestRollback(); err != nil {
				agent.mu.Lock()
				agent.log("error", "rollback: "+err.Error())
				agent.mu.Unlock()
				agent.pushUI()
			}
		}()
	})

	addr := settingsAddr()
	if !isLoopbackListenAddr(addr) {
		log.Fatalf("FLEET_SETTINGS_ADDR must bind loopback (127.0.0.1 / ::1 / localhost), got %q", addr)
	}
	ln, err := listenSettings(addr)
	if err != nil {
		if runtime.GOOS == "linux" {
			log.Println("already running")
			return
		}
		log.Println("already running, opening settings")
		openBrowser(settingsURL())
		time.Sleep(400 * time.Millisecond)
		return
	}
	go settingsNet.serve(ln, secureSettingsHandler(mux))
	if runtime.GOOS == "linux" {
		log.Println("linux tray; hub from FLEET_URL + FLEET_TOKEN or", configPath())
	} else {
		log.Println("settings", settingsURL())
	}

	keepalive.StartLoop()
	keepalive.Set(agent.enabled)
	if agent.enabled {
		agent.mu.Lock()
		agent.log("info", "holding idle-sleep while enabled (screen may lock)")
		agent.mu.Unlock()
	}
	go agent.maintain()
	agent.mu.Lock()
	auto := agent.enabled && strings.TrimSpace(agent.hubInput) != ""
	hub := agent.hubInput
	first := strings.TrimSpace(agent.hubInput) == ""
	agent.mu.Unlock()
	if auto {
		go func() { _ = agent.connect(hub) }()
	}
	if runtime.GOOS != "linux" && (first || !tray.Enabled) {
		openBrowser(settingsURL())
	}
	if runtime.GOOS == "linux" && first {
		log.Println("no hub set: export FLEET_URL and FLEET_TOKEN, then restart")
	}
	tray.Run(agent)
}

func notifyConsent(cmd string) {
	msg := clip(cmd, 80)
	switch runtime.GOOS {
	case "darwin":
		q := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(msg)
		_ = exec.Command("osascript", "-e",
			`display notification "`+q+`" with title "Fleet Agent" subtitle "Needs approval"`).Start()
	case "linux":
		_ = exec.Command("notify-send", "-a", "Fleet Agent", "Needs approval", msg).Start()
	}
}

func openBrowser(url string) {
	if runtime.GOOS == "linux" {
		return
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}
