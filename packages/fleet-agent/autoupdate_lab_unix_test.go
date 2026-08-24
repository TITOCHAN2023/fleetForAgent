//go:build !windows

package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// TestIntranetAutoUpdateLab stands up a loopback hub + two real agent
// binaries (0.3.0 and 0.3.2) and exercises the product auto-update rules.
// The hub speaks the same hello_ok / pong / list_computers / run fields as
// packages/fleet-hub (not a Cloudflare DO). Process replace is a real
// spawn-then-exit of the staged 0.3.2 binary.
func TestIntranetAutoUpdateLab(t *testing.T) {
	oldBin := buildAgentVersion(t, "0.3.0")
	newBin := buildAgentVersion(t, "0.3.2")
	assetName := releaseAssetNames(runtime.GOOS, runtime.GOARCH)[0]
	archive, sum := packLinuxAgentAs(t, newBin, assetName)

	t.Run("1_on_idle_fresh_updates_and_reconnects", func(t *testing.T) {
		lab := newAutoUpdateLab(t, oldBin, archive, assetName, sum)
		lab.hub.setAdvert("0.3.2", lab.baseURL)
		pid0 := lab.startAgent(true, "allow")
		lab.waitOnline("0.3.0")
		newPID := waitReplacedDaemon(t, lab.addr, pid0)
		if newPID == pid0 {
			t.Fatal("expected process replace")
		}
		st := getState(t, lab.addr)
		if st.DeviceID != lab.deviceID {
			t.Fatalf("device id changed: %q", st.DeviceID)
		}
		if st.Permit != PermitAllow {
			t.Fatalf("permit dropped: %q", st.Permit)
		}
		if st.AgentVer != "0.3.2" {
			t.Fatalf("agentVer=%q want 0.3.2", st.AgentVer)
		}
		row := lab.hub.waitComputer(t, lab.deviceID, "0.3.2", true, 15*time.Second)
		if row["permit"] != "allow" {
			t.Fatalf("hub permit=%v", row["permit"])
		}
		t.Logf("PASS scenario 1: pid %d→%d ver 0.3.0→0.3.2 id=%s addr=%s online", pid0, newPID, lab.deviceID, lab.addr)
	})

	t.Run("2_toggle_off_does_not_replace", func(t *testing.T) {
		lab := newAutoUpdateLab(t, oldBin, archive, assetName, sum)
		lab.hub.setAdvert("0.3.2", lab.baseURL)
		pid0 := lab.startAgent(false, "allow")
		lab.waitOnline("0.3.0")
		time.Sleep(3 * time.Second)
		if listenPIDOrZero(lab.addr) != pid0 {
			t.Fatal("toggle off replaced the process")
		}
		st := getState(t, lab.addr)
		if st.AgentVer != "0.3.0" {
			t.Fatalf("ver=%q", st.AgentVer)
		}
		if st.DeviceID != lab.deviceID {
			t.Fatal("device id changed while off")
		}
		t.Logf("PASS scenario 2: pid stayed %d ver 0.3.0 (toggle off)", pid0)
	})

	t.Run("3_busy_waits_until_idle", func(t *testing.T) {
		lab := newAutoUpdateLab(t, oldBin, archive, assetName, sum)
		pid0 := lab.startAgent(true, "allow")
		lab.waitOnline("0.3.0")
		if err := lab.hub.sendRun(lab.deviceID, "sleep 6"); err != nil {
			t.Fatal(err)
		}
		time.Sleep(400 * time.Millisecond)
		lab.hub.setAdvert("0.3.2", lab.baseURL)
		time.Sleep(2 * time.Second)
		if listenPIDOrZero(lab.addr) != pid0 {
			t.Fatal("updated while sleep was running")
		}
		newPID := waitReplacedDaemon(t, lab.addr, pid0)
		st := getState(t, lab.addr)
		if st.AgentVer != "0.3.2" || st.DeviceID != lab.deviceID {
			t.Fatalf("after idle: ver=%q id=%q", st.AgentVer, st.DeviceID)
		}
		t.Logf("PASS scenario 3: stayed %d while busy, then replaced → %d", pid0, newPID)
	})

	t.Run("4_stale_signal_waits_for_fresh_heartbeat", func(t *testing.T) {
		lab := newAutoUpdateLab(t, oldBin, archive, assetName, sum)
		lab.freshS = 2
		lab.hub.setAdvert("0.3.2", lab.baseURL)
		pid0 := lab.startAgent(false, "allow")
		lab.waitOnline("0.3.0")
		lab.hub.setAdvert("", "")
		time.Sleep(3 * time.Second)
		postOK(t, lab.addr, "/api/autoupdate", map[string]bool{"autoUpdate": true})
		time.Sleep(2 * time.Second)
		if listenPIDOrZero(lab.addr) != pid0 {
			t.Fatal("updated from a stale signal")
		}
		if getState(t, lab.addr).AgentVer != "0.3.0" {
			t.Fatal("version changed on stale signal")
		}
		lab.hub.setAdvert("0.3.2", lab.baseURL)
		newPID := waitReplacedDaemon(t, lab.addr, pid0)
		if getState(t, lab.addr).AgentVer != "0.3.2" {
			t.Fatal("did not apply after a fresh heartbeat advert")
		}
		t.Logf("PASS scenario 4: stale ignored (pid %d), fresh advert replaced → %d", pid0, newPID)
	})

	t.Run("5_reconnect_same_id_and_permit", func(t *testing.T) {
		lab := newAutoUpdateLab(t, oldBin, archive, assetName, sum)
		lab.hub.setAdvert("0.3.2", lab.baseURL)
		pid0 := lab.startAgent(true, "ask")
		lab.waitOnline("0.3.0")
		waitReplacedDaemon(t, lab.addr, pid0)
		st := getState(t, lab.addr)
		if st.DeviceID != lab.deviceID {
			t.Fatalf("new device id %q", st.DeviceID)
		}
		if st.Permit != PermitAsk {
			t.Fatalf("permit=%q", st.Permit)
		}
		row := lab.hub.waitComputer(t, lab.deviceID, "0.3.2", true, 15*time.Second)
		if row["permit"] != "ask" {
			t.Fatalf("hub permit=%v", row["permit"])
		}
		t.Logf("PASS scenario 5: same id=%s permit=ask online after restart", lab.deviceID)
	})
}

type autoUpdateLab struct {
	t        *testing.T
	oldBin   string
	archive  string
	asset    string
	sum      string
	home     string
	addr     string
	deviceID string
	baseURL  string
	freshS   int
	hub      *labHub
}

func newAutoUpdateLab(t *testing.T, oldBin, archive, asset, sum string) *autoUpdateLab {
	t.Helper()
	setUpdateChannel("")
	hub := startLabHub(t)
	dl := startAssetServer(t, archive, asset, sum)
	lab := &autoUpdateLab{
		t:        t,
		oldBin:   oldBin,
		archive:  archive,
		asset:    asset,
		sum:      sum,
		home:     filepath.Join(t.TempDir(), "home"),
		addr:     freeLoopback(t),
		deviceID: "lab" + fmt.Sprintf("%d", time.Now().UnixNano())[:16],
		baseURL:  dl,
		freshS:   30,
		hub:      hub,
	}
	return lab
}

func (lab *autoUpdateLab) startAgent(auto bool, permit string) int {
	t := lab.t
	t.Helper()
	if err := os.MkdirAll(lab.home, 0o700); err != nil {
		t.Fatal(err)
	}
	writeJSONFile(t, filepath.Join(lab.home, "config.json"), map[string]any{
		"enabled":    true,
		"permit":     permit,
		"hubInput":   "http://" + lab.hub.addr,
		"hubToken":   "",
		"deviceId":   lab.deviceID,
		"autoUpdate": auto,
	})
	exeDir := filepath.Join(lab.home, "bin")
	if err := os.MkdirAll(exeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(exeDir, "fleet-agent")
	if err := copyFileReplace(lab.oldBin, exe); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(exe, 0o755); err != nil {
		t.Fatal(err)
	}
	env := overlayEnv(os.Environ(), map[string]string{
		"FLEET_HOME":           lab.home,
		"FLEET_SETTINGS_ADDR":  lab.addr,
		"FLEET_URL":            "http://" + lab.hub.addr,
		"FLEET_ENABLED":        "1",
		"FLEET_AUTO_UPDATE":    map[bool]string{true: "1", false: "0"}[auto],
		"FLEET_UPDATE_FRESH_S": fmt.Sprintf("%d", lab.freshS),
		"FLEET_UPDATE_POLL_S":  "1",
		"FLEET_NAME":           "lab-" + lab.deviceID[:8],
		"FLEET_UPDATE_API":     "",
		"FLEET_UPDATE_BASE":    lab.baseURL,
	}, "FLEET_TOKEN", "FLEET_HUB_TOKEN")
	cmd := exec.Command(exe, "--daemon")
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Process.Release()
	pid := waitDaemonPID(t, lab.addr)
	t.Cleanup(func() {
		_ = syscall.Kill(pid, syscall.SIGTERM)
		if cur := listenPIDOrZero(lab.addr); cur > 1 && cur != pid {
			_ = syscall.Kill(cur, syscall.SIGTERM)
		}
	})
	return pid
}

func (lab *autoUpdateLab) waitOnline(ver string) {
	lab.t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		st, err := getStateErr(lab.addr)
		if err == nil && st.Conn == "online" && st.DeviceID == lab.deviceID {
			if ver == "" || st.AgentVer == ver {
				return
			}
		}
		time.Sleep(80 * time.Millisecond)
	}
	st, _ := getStateErr(lab.addr)
	lab.t.Fatalf("agent not online as %s: conn=%s ver=%s", ver, st.Conn, st.AgentVer)
}

func buildAgentVersion(t *testing.T, ver string) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "fleet-agent-"+ver)
	cmd := exec.Command("go", "build", "-ldflags", "-X main.agentVersion="+ver, "-o", bin, ".")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("go build %s: %v\n%s", ver, err, out)
	}
	return bin
}

func packLinuxAgentAs(t *testing.T, bin, assetName string) (string, string) {
	t.Helper()
	body := mustRead(t, bin)
	path := filepath.Join(t.TempDir(), assetName)
	if err := writeBinaryTarGz(path, map[string][]byte{"fleet-agent": body}); err != nil {
		t.Fatal(err)
	}
	sum, err := fileSHA256(path)
	if err != nil {
		t.Fatal(err)
	}
	return path, sum
}

type labHub struct {
	addr    string
	mu      sync.Mutex
	advert  map[string]any
	devices map[string]map[string]any
	conns   map[string]*websocket.Conn
}

func startLabHub(t *testing.T) *labHub {
	t.Helper()
	h := &labHub{devices: map[string]map[string]any{}, conns: map[string]*websocket.Conn{}, advert: map[string]any{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/device", h.handleDevice)
	mux.HandleFunc("/v1/list_computers", h.handleList)
	mux.HandleFunc("/v1/run", h.handleRun)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	h.addr = ln.Addr().String()
	srv := &http.Server{Handler: mux}
	go srv.Serve(ln)
	t.Cleanup(func() { _ = srv.Close() })
	return h
}

func (h *labHub) setAdvert(ver, base string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if ver == "" {
		h.advert = map[string]any{}
		return
	}
	h.advert = map[string]any{"latest_agent_ver": ver, "update_base": base}
}

func (h *labHub) advertCopy() map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := map[string]any{}
	for k, v := range h.advert {
		out[k] = v
	}
	return out
}

func (h *labHub) handleDevice(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"*"}})
	if err != nil {
		return
	}
	id := r.Header.Get("X-Device-Id")
	if id == "" {
		id = "unknown"
	}
	h.mu.Lock()
	h.conns[id] = c
	h.devices[id] = map[string]any{
		"id": id, "name": r.Header.Get("X-Device-Name"), "os": r.Header.Get("X-Device-Os"),
		"online": true, "lastSeen": time.Now().UnixMilli(),
	}
	h.mu.Unlock()
	ctx := context.Background()
	_ = wsjson.Write(ctx, c, Envelope{V: 1, Type: "hello_ok", T: time.Now().UnixMilli(), Body: mergeHB(h.advertCopy())})
	go func() {
		defer func() {
			h.mu.Lock()
			if h.conns[id] == c {
				delete(h.conns, id)
				if d := h.devices[id]; d != nil {
					d["online"] = false
				}
			}
			h.mu.Unlock()
			_ = c.Close(websocket.StatusNormalClosure, "bye")
		}()
		for {
			var env Envelope
			if err := wsjson.Read(ctx, c, &env); err != nil {
				return
			}
			h.mu.Lock()
			d := h.devices[id]
			if d == nil {
				d = map[string]any{"id": id}
				h.devices[id] = d
			}
			d["online"] = true
			d["lastSeen"] = time.Now().UnixMilli()
			if env.Type == "hello" || env.Type == "ping" || env.Type == "heartbeat" {
				if v, _ := env.Body["agent_ver"].(string); v != "" {
					d["agentVer"] = v
				}
				if p, _ := env.Body["permit"].(string); p != "" {
					d["permit"] = p
				}
				if env.Type == "hello" {
					if n, _ := env.Body["hostname"].(string); n != "" {
						d["name"] = n
					}
					if o, _ := env.Body["os"].(string); o != "" {
						d["os"] = o
					}
				}
			}
			h.mu.Unlock()
			if env.Type == "ping" || env.Type == "heartbeat" {
				_ = wsjson.Write(ctx, c, Envelope{V: 1, Type: "pong", ID: env.ID, T: time.Now().UnixMilli(), Body: h.advertCopy()})
			}
		}
	}()
}

func mergeHB(advert map[string]any) map[string]any {
	body := map[string]any{"heartbeat_s": 25}
	for k, v := range advert {
		body[k] = v
	}
	return body
}

func (h *labHub) handleList(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	var comps []map[string]any
	for _, d := range h.devices {
		comps = append(comps, d)
	}
	h.mu.Unlock()
	writeJSON(w, map[string]any{"computers": comps})
}

func (h *labHub) handleRun(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DeviceID string `json:"device_id"`
		Command  string `json:"command"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	h.mu.Lock()
	c := h.conns[body.DeviceID]
	h.mu.Unlock()
	if c == nil {
		http.Error(w, "offline", 409)
		return
	}
	corr := fmt.Sprintf("lab-%d", time.Now().UnixNano())
	_ = wsjson.Write(context.Background(), c, Envelope{
		V: 1, Type: "run", Corr: corr, T: time.Now().UnixMilli(),
		Body: map[string]any{"command": body.Command},
	})
	writeJSON(w, map[string]any{"corr": corr, "status": "running"})
}

func (h *labHub) sendRun(id, cmd string) error {
	res, err := http.Post("http://"+h.addr+"/v1/run", "application/json", stringsReader(mustJSON(map[string]string{
		"device_id": id, "command": cmd,
	})))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("run %s", res.Status)
	}
	return nil
}

func (h *labHub) waitComputer(t *testing.T, id, ver string, online bool, timeout time.Duration) map[string]any {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var last map[string]any
	for time.Now().Before(deadline) {
		h.mu.Lock()
		row := h.devices[id]
		h.mu.Unlock()
		if row != nil {
			last = row
			gotVer, _ := row["agentVer"].(string)
			gotOn, _ := row["online"].(bool)
			if gotOn == online && (ver == "" || gotVer == ver) {
				return row
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("hub catalog never reached id=%s ver=%s online=%v last=%v", id, ver, online, last)
	return nil
}

func startAssetServer(t *testing.T, archive, name, sum string) string {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/checksums.txt", func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintf(w, "%s  %s\n", sum, name)
	})
	mux.HandleFunc("/"+name, func(w http.ResponseWriter, r *http.Request) {
		f, err := os.Open(archive)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer f.Close()
		_, _ = io.Copy(w, f)
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: mux}
	go srv.Serve(ln)
	t.Cleanup(func() { _ = srv.Close() })
	return "http://" + ln.Addr().String()
}

func writeBinaryTarGz(path string, files map[string][]byte) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	gz := gzip.NewWriter(f)
	defer gz.Close()
	tw := tar.NewWriter(gz)
	defer tw.Close()
	for name, body := range files {
		hdr := &tar.Header{Name: name, Mode: 0755, Size: int64(len(body))}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if _, err := tw.Write(body); err != nil {
			return err
		}
	}
	return nil
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
