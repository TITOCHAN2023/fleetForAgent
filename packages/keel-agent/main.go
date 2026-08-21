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
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
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
		a.save()
	}
}

func normalizeHub(raw string) (wss string, err error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", fmt.Errorf("Enter the Worker domain")
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
	defer a.mu.Unlock()
	a.enabled = on
	if !on {
		a.disconnectLocked("本机开关已关闭")
	}
	a.log("info", map[bool]string{true: "agent enabled", false: "agent disabled"}[on])
	a.save()
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
		"X-Device-Name": {hostname()},
		"X-Device-Os":   {osKind()},
	}
	tok := a.hubToken
	if tok == "" {
		tok = os.Getenv("KEEL_HUB_TOKEN")
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
		return err
	}
	a.ws = c
	a.conn = "online"
	a.log("info", "online id="+deviceID)
	a.save()
	hello := Envelope{V: 1, Type: "hello", ID: fmt.Sprintf("%d", time.Now().UnixNano()), T: time.Now().UnixMilli(), Body: map[string]any{
		"os":        osKind(),
		"arch":      runtime.GOARCH,
		"hostname":  hostname(),
		"caps":      []string{"shell"},
		"agent_ver": "0.2.0",
		"permit":    string(a.permit),
		"egress":    "internet",
		"device_id": deviceID,
	}}
	a.mu.Unlock()
	_ = wsjson.Write(ctx, c, hello)
	go a.readLoop(ctx, c)
	return nil
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
		return "keel-agent"
	}
	return h
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
			a.handleRun(ctx, c, env.Corr, cmd)
		}
	}
}

func (a *Agent) handleRun(ctx context.Context, c *websocket.Conn, corr, cmd string) {
	a.mu.Lock()
	if !a.enabled || a.permit == PermitOff {
		a.log("warn", "refused (off): "+cmd)
		a.mu.Unlock()
		_ = wsjson.Write(ctx, c, resultEnv(corr, false, 126, "", "keel: permit=off — 本机不允许执行"))
		return
	}
	if destructive.MatchString(cmd) {
		a.log("error", "blocked destructive: "+cmd)
		a.mu.Unlock()
		_ = wsjson.Write(ctx, c, resultEnv(corr, false, 126, "", "keel: refused by device policy"))
		return
	}
	if a.permit == PermitAsk {
		if a.pending != nil {
			a.mu.Unlock()
			_ = wsjson.Write(ctx, c, resultEnv(corr, false, 1, "", "keel: another command is waiting for consent"))
			return
		}
		a.pending = &Pending{Corr: corr, Command: cmd, Requested: time.Now().UnixMilli()}
		a.log("warn", "waiting consent: "+cmd)
		a.mu.Unlock()
		return
	}
	a.mu.Unlock()
	stdout, stderr, code := runCmd(cmd)
	a.mu.Lock()
	a.log("info", fmt.Sprintf("result %d: %s", code, cmd))
	a.mu.Unlock()
	if stdout != "" {
		_ = wsjson.Write(ctx, c, Envelope{V: 1, Type: "chunk", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: corr, T: time.Now().UnixMilli(), Body: map[string]any{"stream": "stdout", "data": stdout}})
	}
	if stderr != "" {
		_ = wsjson.Write(ctx, c, Envelope{V: 1, Type: "chunk", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: corr, T: time.Now().UnixMilli(), Body: map[string]any{"stream": "stderr", "data": stderr}})
	}
	_ = wsjson.Write(ctx, c, resultEnv(corr, code == 0, code, stdout, stderr))
}

func resultEnv(corr string, ok bool, code int, stdout, stderr string) Envelope {
	return Envelope{V: 1, Type: "result", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: corr, T: time.Now().UnixMilli(), Body: map[string]any{"ok": ok, "exit_code": code, "error": stderr}}
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
	stdout, stderr, code := runCmd(p.Command)
	ctx := context.Background()
	if stdout != "" {
		_ = wsjson.Write(ctx, ws, Envelope{V: 1, Type: "chunk", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: p.Corr, T: time.Now().UnixMilli(), Body: map[string]any{"stream": "stdout", "data": stdout}})
	}
	_ = wsjson.Write(ctx, ws, resultEnv(p.Corr, code == 0, code, stdout, stderr))
	a.mu.Lock()
	a.log("info", "approved: "+p.Command)
	a.mu.Unlock()
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
	_ = wsjson.Write(context.Background(), ws, resultEnv(p.Corr, false, 1, "", "keel: denied at the machine"))
	a.mu.Lock()
	a.log("warn", "denied: "+p.Command)
	a.mu.Unlock()
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func main() {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".keel-agent")
	_ = os.MkdirAll(dir, 0o700)
	agent := &Agent{permit: PermitAsk, conn: "offline", cfgPath: filepath.Join(dir, "config.json")}
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
		agent.mu.Lock()
		if body.Permit == PermitOff || body.Permit == PermitAsk || body.Permit == PermitAllow {
			agent.permit = body.Permit
			agent.log("info", "permit → "+string(body.Permit))
			agent.save()
		}
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
		if body.Token != "" || body.Hub != "" {
			agent.mu.Lock()
			if body.Token != "" {
				agent.hubToken = body.Token
			}
			agent.save()
			agent.mu.Unlock()
		}
		go func() { _ = agent.connect(body.Hub) }()
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

	ln, err := net.Listen("tcp", "127.0.0.1:17890")
	if err != nil {
		log.Fatal(err)
	}
	url := "http://127.0.0.1:17890"
	log.Println("settings", url)
	openBrowser(url)
	log.Fatal(http.Serve(ln, mux))
}

func openBrowser(url string) {
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
