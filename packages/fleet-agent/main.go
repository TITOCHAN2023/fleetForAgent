package main

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const (
	agentVersion = "0.2.4"
)

//go:embed ui/index.html
var uiHTML []byte

var destructive = regexp.MustCompile(`(?i)rm\s+-rf|del\s+/f|format\s+c:|shutdown|reboot|mkfs|diskpart`)

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

type Pending struct {
	Corr      string `json:"corr"`
	Command   string `json:"command"`
	Requested int64  `json:"requestedAt"`
}

type Envelope struct {
	V    int            `json:"v"`
	Type string         `json:"type"`
	ID   string         `json:"id"`
	Corr string         `json:"corr,omitempty"`
	T    int64          `json:"t"`
	Body map[string]any `json:"body"`
}

type State struct {
	Enabled  bool      `json:"enabled"`
	Permit   Permit    `json:"permit"`
	HubInput string    `json:"hubInput"`
	HubToken string    `json:"hubToken"`
	DeviceID string    `json:"deviceId"`
	WSS      string    `json:"wss"`
	Conn     string    `json:"conn"`
	Error    string    `json:"error"`
	Logs     []LogLine `json:"logs"`
	Pending  *Pending  `json:"pending"`
}

type Agent struct {
	mu       sync.Mutex
	enabled  bool
	permit   Permit
	hubInput string
	hubToken string
	deviceID string
	wss      string
	conn     string
	err      string
	logs     []LogLine
	pending  *Pending
	seq      int
	ws       *websocket.Conn
	cancel   context.CancelFunc
	cfgPath  string
	panes    *supervisor
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
	return State{
		Enabled:  a.enabled,
		Permit:   a.permit,
		HubInput: a.hubInput,
		HubToken: a.hubToken,
		DeviceID: a.deviceID,
		WSS:      a.wss,
		Conn:     a.conn,
		Error:    a.err,
		Logs:     logs,
		Pending:  a.pending,
	}
}

func (a *Agent) save() {
	b, _ := json.MarshalIndent(map[string]any{
		"enabled":  a.enabled,
		"permit":   a.permit,
		"hubInput": a.hubInput,
		"hubToken": a.hubToken,
		"deviceId": a.deviceID,
	}, "", "  ")
	_ = os.WriteFile(a.cfgPath, b, 0o600)
}

func (a *Agent) load() {
	b, err := os.ReadFile(a.cfgPath)
	if err != nil {
		a.permit = PermitAsk
		a.deviceID = newDeviceID()
		a.applyEnv(false)
		a.save()
		return
	}
	var cfg struct {
		Enabled  bool   `json:"enabled"`
		Permit   Permit `json:"permit"`
		HubInput string `json:"hubInput"`
		HubToken string `json:"hubToken"`
		DeviceID string `json:"deviceId"`
	}
	if json.Unmarshal(b, &cfg) == nil {
		a.enabled = cfg.Enabled
		a.permit = cfg.Permit
		a.hubInput = cfg.HubInput
		a.hubToken = cfg.HubToken
		a.deviceID = cfg.DeviceID
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
	setKeepAlive(on)
	if on && strings.TrimSpace(hub) != "" {
		go func() { _ = a.connect(hub) }()
	}
	a.pushUI()
}

func (a *Agent) setPermit(p Permit) {
	a.mu.Lock()
	if p == PermitOff || p == PermitAsk || p == PermitAllow {
		a.permit = p
		a.log("info", "permit → "+string(p))
		a.save()
	}
	a.mu.Unlock()
	a.pushUI()
}

func (a *Agent) pushUI() {
	a.mu.Lock()
	s := a.snapshot()
	a.mu.Unlock()
	updateTray(s)
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
	a.conn = "offline"
	a.log("warn", reason)
}

func (a *Agent) connect(hub string) error {
	a.mu.Lock()
	if !a.enabled {
		a.mu.Unlock()
		return fmt.Errorf("Turn on this computer first")
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
	headers := map[string][]string{
		"X-Fleet-Proto": {"1"},
		"X-Device-Id":   {a.deviceID},
		"X-Device-Name": {deviceName()},
		"X-Device-Os":   {osKind()},
	}
	tok := a.hubToken
	if tok == "" {
		tok = os.Getenv("FLEET_HUB_TOKEN")
	}
	if tok != "" {
		headers["Authorization"] = []string{"Bearer " + tok}
	}
	deviceID := a.deviceID
	a.mu.Unlock()

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
	a.ws = c
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
	return nil
}

func (a *Agent) maintain() {
	backoff := time.Second
	for {
		time.Sleep(500 * time.Millisecond)
		a.mu.Lock()
		want := a.enabled && strings.TrimSpace(a.hubInput) != "" && a.ws == nil && a.conn != "connecting"
		hub := a.hubInput
		a.mu.Unlock()
		if !want {
			backoff = time.Second
			continue
		}
		time.Sleep(backoff)
		a.mu.Lock()
		want = a.enabled && strings.TrimSpace(a.hubInput) != "" && a.ws == nil && a.conn != "connecting"
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
	if runtime.GOOS == "windows" {
		return []string{"shell", "pane"}
	}
	return []string{"shell", "pane", "live_shell"}
}

func (a *Agent) readLoop(ctx context.Context, c *websocket.Conn) {
	defer func() {
		a.mu.Lock()
		if a.ws == c {
			a.ws = nil
			a.conn = "offline"
			a.log("warn", "socket closed")
		}
		a.mu.Unlock()
		a.pushUI()
	}()
	for {
		var env Envelope
		if err := wsjson.Read(ctx, c, &env); err != nil {
			return
		}
		switch env.Type {
		case "ping":
			_ = wsjson.Write(ctx, c, Envelope{V: 1, Type: "pong", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: env.ID, T: time.Now().UnixMilli(), Body: map[string]any{}})
		case "run":
			cmd, _ := env.Body["command"].(string)
			go a.handleRun(ctx, c, env.Corr, cmd)
		case "type":
			keys, _ := env.Body["keys"].(string)
			id, _ := env.Body["pane_id"].(string)
			if id == "" {
				id, _ = env.Body["corr"].(string)
			}
			go a.handleType(ctx, c, env.Corr, id, keys)
		case "read_screen":
			id, _ := env.Body["pane_id"].(string)
			if id == "" {
				id, _ = env.Body["corr"].(string)
			}
			a.handleScreen(ctx, c, env.Corr, id)
		case "list_panes":
			a.mu.Lock()
			list := a.panes.list()
			a.mu.Unlock()
			_ = wsjson.Write(ctx, c, Envelope{V: 1, Type: "panes", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: env.Corr, T: time.Now().UnixMilli(), Body: map[string]any{"panes": list}})
		}
	}
}

func (a *Agent) handleRun(ctx context.Context, c *websocket.Conn, corr, cmd string) {
	a.mu.Lock()
	if !a.enabled || a.permit == PermitOff {
		a.log("warn", "refused (off): "+cmd)
		a.mu.Unlock()
		_ = wsjson.Write(ctx, c, resultEnv(corr, false, 126, "", "fleet: permit=off — 本机不允许执行"))
		return
	}
	if destructive.MatchString(cmd) {
		a.log("error", "blocked destructive: "+cmd)
		a.mu.Unlock()
		_ = wsjson.Write(ctx, c, resultEnv(corr, false, 126, "", "fleet: refused by device policy"))
		return
	}
	if a.permit == PermitAsk {
		if a.pending != nil {
			a.mu.Unlock()
			_ = wsjson.Write(ctx, c, resultEnv(corr, false, 1, "", "fleet: another command is waiting for consent"))
			return
		}
		a.pending = &Pending{Corr: corr, Command: cmd, Requested: time.Now().UnixMilli()}
		a.log("warn", "waiting consent: "+cmd)
		a.mu.Unlock()
		notifyConsent(cmd)
		a.pushUI()
		return
	}
	a.mu.Unlock()
	a.spawnPane(ctx, c, corr, cmd)
}

func (a *Agent) spawnPane(ctx context.Context, c *websocket.Conn, corr, cmd string) {
	a.mu.Lock()
	if a.panes == nil {
		a.panes = newSupervisor()
	}
	sup := a.panes
	a.mu.Unlock()
	p, err := sup.spawn(corr, cmd)
	if err != nil {
		_ = wsjson.Write(ctx, c, resultEnv(corr, false, 1, "", err.Error()))
		return
	}
	_ = wsjson.Write(ctx, c, Envelope{V: 1, Type: "accepted", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: corr, T: time.Now().UnixMilli(), Body: map[string]any{"pane_id": p.id, "status": "running"}})
	a.mu.Lock()
	a.log("info", "pane accepted "+p.id)
	a.mu.Unlock()
	go func() {
		for {
			p.mu.Lock()
			done := !p.running
			code := p.exitCode
			p.mu.Unlock()
			if done {
				stdout, stderr := p.resultText()
				_ = wsjson.Write(ctx, c, resultEnv(corr, code == 0, code, stdout, stderr))
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

func (a *Agent) handleType(ctx context.Context, c *websocket.Conn, corr, id, keys string) {
	a.mu.Lock()
	sup := a.panes
	a.mu.Unlock()
	if sup == nil {
		_ = wsjson.Write(ctx, c, Envelope{V: 1, Type: "typed", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: corr, T: time.Now().UnixMilli(), Body: map[string]any{"ok": false, "error": "no pane"}})
		return
	}
	p := sup.get(id)
	if p == nil {
		_ = wsjson.Write(ctx, c, Envelope{V: 1, Type: "typed", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: corr, T: time.Now().UnixMilli(), Body: map[string]any{"ok": false, "error": "pane gone"}})
		return
	}
	err := p.typeKeys(keys)
	ok := err == nil
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	_ = wsjson.Write(ctx, c, Envelope{V: 1, Type: "typed", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: corr, T: time.Now().UnixMilli(), Body: map[string]any{"ok": ok, "error": msg}})
}

func (a *Agent) handleScreen(ctx context.Context, c *websocket.Conn, corr, id string) {
	a.mu.Lock()
	sup := a.panes
	a.mu.Unlock()
	if sup == nil {
		_ = wsjson.Write(ctx, c, Envelope{V: 1, Type: "screen", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: corr, T: time.Now().UnixMilli(), Body: map[string]any{"text": "", "running": false}})
		return
	}
	p := sup.get(id)
	if p == nil {
		_ = wsjson.Write(ctx, c, Envelope{V: 1, Type: "screen", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: corr, T: time.Now().UnixMilli(), Body: map[string]any{"text": "", "running": false}})
		return
	}
	text, running, code, seq := p.snapshot()
	_ = wsjson.Write(ctx, c, Envelope{V: 1, Type: "screen", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: corr, T: time.Now().UnixMilli(), Body: map[string]any{
		"pane_id": p.id, "text": text, "running": running, "exit_code": code, "seq": seq,
	}})
}

func (a *Agent) coalesceLoop(ctx context.Context, c *websocket.Conn) {
	tick := time.NewTicker(screenInterval)
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
			p := sup.takeDirty()
			if p == nil {
				continue
			}
			text, running, code, seq := p.snapshot()
			_ = wsjson.Write(ctx, c, Envelope{V: 1, Type: "screen", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: p.corr, T: time.Now().UnixMilli(), Body: map[string]any{
				"pane_id": p.id, "text": text, "running": running, "exit_code": code, "seq": seq,
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
	p := a.pending
	ws := a.ws
	a.pending = nil
	a.mu.Unlock()
	if p == nil || ws == nil {
		return
	}
	go a.spawnPane(context.Background(), ws, p.Corr, p.Command)
	a.mu.Lock()
	a.log("info", "approved: "+p.Command)
	a.mu.Unlock()
	a.pushUI()
}

func (a *Agent) deny() {
	a.mu.Lock()
	p := a.pending
	ws := a.ws
	a.pending = nil
	a.mu.Unlock()
	if p == nil || ws == nil {
		return
	}
	_ = wsjson.Write(context.Background(), ws, resultEnv(p.Corr, false, 1, "", "fleet: denied at the machine"))
	a.mu.Lock()
	a.log("warn", "denied: "+p.Command)
	a.mu.Unlock()
	a.pushUI()
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

	dir := fleetHome()
	_ = os.MkdirAll(dir, 0o700)
	agent := &Agent{permit: PermitAsk, conn: "offline", cfgPath: configPath(), panes: newSupervisor()}
	agent.load()

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/html; charset=utf-8")
		_, _ = w.Write(uiHTML)
	})
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		agent.mu.Lock()
		s := agent.snapshot()
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
		s := agent.snapshot()
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
		s := agent.snapshot()
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
		if body.Token != "" {
			agent.hubToken = body.Token
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
		s := agent.snapshot()
		agent.mu.Unlock()
		writeJSON(w, s)
	})
	mux.HandleFunc("/api/approve", func(w http.ResponseWriter, r *http.Request) {
		agent.approve()
		agent.mu.Lock()
		s := agent.snapshot()
		agent.mu.Unlock()
		writeJSON(w, s)
	})
	mux.HandleFunc("/api/deny", func(w http.ResponseWriter, r *http.Request) {
		agent.deny()
		agent.mu.Lock()
		s := agent.snapshot()
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
			setKeepAlive(false)
			requestQuit()
		}()
	})

	ln, err := net.Listen("tcp", settingsAddr())
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
	go func() {
		log.Fatal(http.Serve(ln, mux))
	}()
	if runtime.GOOS == "linux" {
		log.Println("linux tray; hub from FLEET_URL + FLEET_TOKEN or", configPath())
	} else {
		log.Println("settings", settingsURL())
	}

	startKeepAliveLoop()
	setKeepAlive(agent.enabled)
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
	if runtime.GOOS != "linux" && (first || !trayEnabled) {
		openBrowser(settingsURL())
	}
	if runtime.GOOS == "linux" && first {
		log.Println("no hub set: export FLEET_URL and FLEET_TOKEN, then restart")
	}
	runTray(agent)
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
