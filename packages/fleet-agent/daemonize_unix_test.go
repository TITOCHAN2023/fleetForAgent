//go:build !windows

package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestWantsDaemonize(t *testing.T) {
	if wantsDaemonize(nil) || wantsDaemonize([]string{}) {
		t.Fatal("no-args is the tray/.app path and must not daemonize")
	}
	if !wantsDaemonize([]string{"--daemon"}) || !wantsDaemonize([]string{"daemon"}) {
		t.Fatal("--daemon / daemon must daemonize")
	}
	if wantsDaemonize([]string{"start"}) || wantsDaemonize([]string{"status"}) {
		t.Fatal("CLI commands must not daemonize")
	}
}

func TestDaemonDetachesFromLiveShellPTY(t *testing.T) {
	bin := buildAgent(t)
	home := t.TempDir()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	t.Setenv("FLEET_HOME", home)
	t.Setenv("FLEET_SETTINGS_ADDR", addr)
	t.Setenv("FLEET_NAME", "daemon-pty-test")
	t.Setenv("FLEET_URL", "")
	t.Setenv("FLEET_TOKEN", "")
	t.Setenv("FLEET_HUB", "")
	t.Setenv("FLEET_HUB_TOKEN", "")

	s := newSupervisor()
	t.Cleanup(func() {
		s.mu.Lock()
		if s.live != nil {
			s.live.kill()
		}
		s.mu.Unlock()
	})

	p, err := s.spawn("dmn1", strconv.Quote(bin)+" --daemon")
	if err != nil {
		t.Fatal(err)
	}
	waitPaneDone(t, p)
	if p.stillRunning() {
		t.Fatal("--daemon parent must exit after detaching")
	}

	s.mu.Lock()
	live := s.live
	s.mu.Unlock()
	if live == nil || live.cmd == nil || live.cmd.Process == nil {
		t.Fatal("live shell gone")
	}
	parentPts := processPts(live.cmd.Process.Pid)
	if len(parentPts) == 0 {
		t.Fatal("live shell has no pts; cannot check daemon fds")
	}

	pid := waitDaemonPID(t, addr)
	t.Cleanup(func() {
		_ = syscall.Kill(pid, syscall.SIGTERM)
	})

	if ppid := processPpid(pid); ppid != 1 {
		t.Fatalf("daemon ppid=%d want 1 (orphaned after double-fork)", ppid)
	}
	for _, pt := range parentPts {
		if processHasPath(pid, pt) {
			t.Fatalf("daemon fd still refers to parent pts %s", pt)
		}
	}
	if lsof, err := exec.LookPath("lsof"); err == nil {
		out, _ := exec.Command(lsof, "-nP", "-p", strconv.Itoa(pid)).Output()
		for _, pt := range parentPts {
			if pt != "" && strings.Contains(string(out), pt) {
				t.Fatalf("lsof shows parent pts %s:\n%s", pt, out)
			}
		}
	}

	resp, err := http.Get("http://" + addr + "/api/state")
	if err != nil {
		t.Fatalf("daemon stopped listening after the run finished: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("daemon http %s", resp.Status)
	}
}

func buildAgent(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "fleet-agent")
	cmd := exec.Command("go", "build", "-o", bin, ".")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
}

func waitDaemonPID(t *testing.T, addr string) int {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		resp, err := http.Get("http://" + addr + "/api/state")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				if pid, err := listenPID(addr); err == nil && pid > 1 {
					return pid
				} else {
					last = err
				}
			}
		} else {
			last = err
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("daemon never listened on %s: %v", addr, last)
	return 0
}

func listenPID(addr string) (int, error) {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return 0, err
	}
	if runtime.GOOS == "linux" {
		if pid, err := linuxListenPID(port); err == nil {
			return pid, nil
		}
	}
	if lsof, err := exec.LookPath("lsof"); err == nil {
		out, err := exec.Command(lsof, "-nP", "-iTCP:"+addr, "-sTCP:LISTEN", "-t").Output()
		if err == nil {
			for _, line := range strings.Split(string(out), "\n") {
				if pid, err := strconv.Atoi(strings.TrimSpace(line)); err == nil && pid > 1 {
					return pid, nil
				}
			}
		}
		out, err = exec.Command(lsof, "-nP", "-iTCP:"+port, "-sTCP:LISTEN", "-t").Output()
		if err == nil {
			for _, line := range strings.Split(string(out), "\n") {
				if pid, err := strconv.Atoi(strings.TrimSpace(line)); err == nil && pid > 1 {
					return pid, nil
				}
			}
		}
	}
	return 0, fmt.Errorf("no listener pid for %s", addr)
}

func linuxListenPID(port string) (int, error) {
	want, err := strconv.Atoi(port)
	if err != nil {
		return 0, err
	}
	b, err := os.ReadFile("/proc/net/tcp")
	if err != nil {
		return 0, err
	}
	var inodes []string
	for _, line := range strings.Split(string(b), "\n")[1:] {
		fields := strings.Fields(line)
		if len(fields) < 10 {
			continue
		}
		if fields[3] != "0A" {
			continue
		}
		hp := strings.Split(fields[1], ":")
		if len(hp) != 2 {
			continue
		}
		p, err := strconv.ParseInt(hp[1], 16, 0)
		if err != nil || int(p) != want {
			continue
		}
		inodes = append(inodes, fields[9])
	}
	if len(inodes) == 0 {
		if b6, err := os.ReadFile("/proc/net/tcp6"); err == nil {
			for _, line := range strings.Split(string(b6), "\n")[1:] {
				fields := strings.Fields(line)
				if len(fields) < 10 || fields[3] != "0A" {
					continue
				}
				hp := strings.Split(fields[1], ":")
				if len(hp) != 2 {
					continue
				}
				p, err := strconv.ParseInt(hp[1], 16, 0)
				if err != nil || int(p) != want {
					continue
				}
				inodes = append(inodes, fields[9])
			}
		}
	}
	wantSock := map[string]bool{}
	for _, ino := range inodes {
		wantSock["socket:["+ino+"]"] = true
	}
	procs, err := os.ReadDir("/proc")
	if err != nil {
		return 0, err
	}
	for _, p := range procs {
		pid, err := strconv.Atoi(p.Name())
		if err != nil || pid <= 1 {
			continue
		}
		fds, err := os.ReadDir("/proc/" + p.Name() + "/fd")
		if err != nil {
			continue
		}
		for _, fd := range fds {
			target, err := os.Readlink("/proc/" + p.Name() + "/fd/" + fd.Name())
			if err != nil {
				continue
			}
			if wantSock[target] {
				return pid, nil
			}
		}
	}
	return 0, fmt.Errorf("no /proc listener for port %s", port)
}

func processPpid(pid int) int {
	if runtime.GOOS == "linux" {
		b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/status")
		if err == nil {
			for _, line := range strings.Split(string(b), "\n") {
				if strings.HasPrefix(line, "PPid:") {
					n, _ := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "PPid:")))
					return n
				}
			}
		}
	}
	out, err := exec.Command("ps", "-o", "ppid=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return -1
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	return n
}

func processPts(pid int) []string {
	seen := map[string]bool{}
	if runtime.GOOS == "linux" {
		fds, err := os.ReadDir("/proc/" + strconv.Itoa(pid) + "/fd")
		if err == nil {
			for _, fd := range fds {
				target, err := os.Readlink("/proc/" + strconv.Itoa(pid) + "/fd/" + fd.Name())
				if err != nil {
					continue
				}
				if strings.HasPrefix(target, "/dev/pts/") {
					seen[target] = true
				}
			}
		}
	}
	if lsof, err := exec.LookPath("lsof"); err == nil {
		out, err := exec.Command(lsof, "-Fn", "-p", strconv.Itoa(pid)).Output()
		if err == nil {
			for _, line := range strings.Split(string(out), "\n") {
				if strings.HasPrefix(line, "n/dev/pts/") || strings.HasPrefix(line, "n/dev/ttys") {
					seen[strings.TrimPrefix(line, "n")] = true
				}
			}
		}
	}
	out := make([]string, 0, len(seen))
	for p := range seen {
		out = append(out, p)
	}
	return out
}

func processHasPath(pid int, path string) bool {
	if path == "" {
		return false
	}
	if runtime.GOOS == "linux" {
		fds, err := os.ReadDir("/proc/" + strconv.Itoa(pid) + "/fd")
		if err == nil {
			for _, fd := range fds {
				target, err := os.Readlink("/proc/" + strconv.Itoa(pid) + "/fd/" + fd.Name())
				if err != nil {
					continue
				}
				if target == path || strings.HasSuffix(target, path) {
					return true
				}
			}
		}
	}
	if lsof, err := exec.LookPath("lsof"); err == nil {
		out, err := exec.Command(lsof, "-nP", "-p", strconv.Itoa(pid)).Output()
		if err == nil && strings.Contains(string(out), path) {
			return true
		}
	}
	return false
}
