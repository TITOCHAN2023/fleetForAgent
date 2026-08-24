//go:build !windows

package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestSelfRestartKeepsListenAddrAndDeviceID(t *testing.T) {
	bin := buildAgent(t)
	homeA := filepath.Join(t.TempDir(), "prod")
	homeB := filepath.Join(t.TempDir(), "test")
	addrA := freeLoopback(t)
	addrB := freeLoopback(t)
	idA := "0af361d05eee4e15a344fdab312c25a9"
	idB := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	writeAgentCfg(t, homeA, idA, "allow")
	writeAgentCfg(t, homeB, idB, "ask")

	pidA := startTestDaemon(t, bin, homeA, addrA)
	pidB := startTestDaemon(t, bin, homeB, addrB)

	stA := getState(t, addrA)
	stB := getState(t, addrB)
	if stA.DeviceID != idA || stB.DeviceID != idB {
		t.Fatalf("ids A=%q B=%q", stA.DeviceID, stB.DeviceID)
	}

	postOK(t, addrA, "/api/restart", map[string]string{})
	newA := waitDaemonPID(t, addrA)
	if newA == pidA {
		t.Fatalf("expected a new process on %s, still pid %d", addrA, pidA)
	}
	if listenPIDOrZero(addrB) != pidB {
		t.Fatalf("sibling on %s must stay pid %d", addrB, pidB)
	}
	stA2 := getState(t, addrA)
	stB2 := getState(t, addrB)
	if stA2.DeviceID != idA {
		t.Fatalf("device id changed on restart: %q", stA2.DeviceID)
	}
	if stB2.DeviceID != idB {
		t.Fatalf("sibling device id changed: %q", stB2.DeviceID)
	}
	if stA2.Permit != PermitAllow {
		t.Fatalf("permit dropped: %q", stA2.Permit)
	}
}

func TestSelfUpdateStagesAndRestarts(t *testing.T) {
	bin := buildAgent(t)
	home := filepath.Join(t.TempDir(), "home")
	addr := freeLoopback(t)
	id := "cccccccccccccccccccccccccccccccc"
	writeAgentCfg(t, home, id, "ask")
	_ = startTestDaemon(t, bin, home, addr)

	archive, sum := packLinuxAgent(t, bin)
	name := "fleet-agent-linux-amd64.tar.gz"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/checksums.txt":
			_, _ = w.Write([]byte(sum + "  " + name + "\n"))
		case "/" + name:
			f, err := os.Open(archive)
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			defer f.Close()
			_, _ = io.Copy(w, f)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	// Point only the running daemon at the fake channel via its environment:
	// the daemon already started, so POST an explicit url+sha instead.
	postOK(t, addr, "/api/update", updateRequest{
		URL:    srv.URL + "/" + name,
		SHA256: sum,
		Force:  true,
	})
	deadline := time.Now().Add(25 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		st, err := getStateErr(addr)
		if err == nil && st.DeviceID == id {
			if st.AgentVer != "" {
				return
			}
		} else {
			last = err
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("updated agent did not come back on %s: %v", addr, last)
}

func freeLoopback(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	return addr
}

func writeAgentCfg(t *testing.T, home, deviceID, permit string) {
	t.Helper()
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	b, _ := json.MarshalIndent(map[string]any{
		"enabled":  false,
		"permit":   permit,
		"hubInput": "",
		"hubToken": "",
		"deviceId": deviceID,
	}, "", "  ")
	if err := os.WriteFile(filepath.Join(home, "config.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func startTestDaemon(t *testing.T, bin, home, addr string) int {
	t.Helper()
	t.Setenv("FLEET_HOME", home)
	t.Setenv("FLEET_SETTINGS_ADDR", addr)
	t.Setenv("FLEET_URL", "")
	t.Setenv("FLEET_TOKEN", "")
	t.Setenv("FLEET_HUB", "")
	t.Setenv("FLEET_HUB_TOKEN", "")
	t.Setenv("FLEET_ENABLED", "0")
	cmd := testDaemonCmd(bin)
	cmd.Env = overlayEnv(os.Environ(), map[string]string{
		"FLEET_HOME":          home,
		"FLEET_SETTINGS_ADDR": addr,
		"FLEET_ENABLED":       "0",
	}, "FLEET_URL", "FLEET_TOKEN", "FLEET_HUB", "FLEET_HUB_TOKEN")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Process.Release()
	pid := waitDaemonPID(t, addr)
	t.Cleanup(func() {
		_ = syscall.Kill(pid, syscall.SIGTERM)
		if cur, err := listenPID(addr); err == nil && cur > 1 && cur != pid {
			_ = syscall.Kill(cur, syscall.SIGTERM)
		}
	})
	return pid
}

func getState(t *testing.T, addr string) State {
	t.Helper()
	st, err := getStateErr(addr)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func getStateErr(addr string) (State, error) {
	res, err := http.Get("http://" + addr + "/api/state")
	if err != nil {
		return State{}, err
	}
	defer res.Body.Close()
	var st State
	if err := json.NewDecoder(res.Body).Decode(&st); err != nil {
		return State{}, err
	}
	return st, nil
}

func postOK(t *testing.T, addr, path string, body any) {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.Post("http://"+addr+path, "application/json", stringsReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		t.Fatalf("%s: %s", path, res.Status)
	}
}

func listenPIDOrZero(addr string) int {
	pid, err := listenPID(addr)
	if err != nil {
		return 0
	}
	return pid
}

func packLinuxAgent(t *testing.T, bin string) (string, string) {
	t.Helper()
	body, err := os.ReadFile(bin)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "fleet-agent-linux-amd64.tar.gz")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	hdr := &tar.Header{Name: "fleet-agent", Mode: 0755, Size: int64(len(body))}
	if err := tw.WriteHeader(hdr); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(body); err != nil {
		t.Fatal(err)
	}
	_ = tw.Close()
	_ = gz.Close()
	_ = f.Close()
	sum := sha256.Sum256(mustRead(t, path))
	return path, hex.EncodeToString(sum[:])
}

func testDaemonCmd(bin string) *exec.Cmd {
	cmd := exec.Command(bin, "--daemon")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return cmd
}

func stringsReader(b []byte) io.Reader {
	return bytes.NewReader(b)
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
