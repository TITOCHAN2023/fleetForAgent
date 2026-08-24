package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// restartModeSpawnThenExit is the only supported handoff.
// It is not "quit and hope": this process releases the settings port, starts
// a successor with THIS process's listen addr and home, waits until that
// successor answers /api/state, then exits. A scheduled `open -a` / `start /B`
// babysitter is not used — those die with the parent or only foreground a
// leftover process.
const restartModeSpawnThenExit = "spawn-then-exit"

type restartPlan struct {
	Mode string
	Exe  string
	Args []string
	Addr string
	Home string
	Env  []string
}

type settingsHTTP struct {
	mu      sync.Mutex
	srv     *http.Server
	ln      net.Listener
	handler http.Handler
	addr    string
}

var settingsNet settingsHTTP

var (
	handoffMu   sync.Mutex
	handoffBusy bool
)

func overlayEnv(base []string, set map[string]string, unset ...string) []string {
	skip := map[string]bool{}
	for _, k := range unset {
		skip[k] = true
	}
	for k := range set {
		skip[k] = true
	}
	out := make([]string, 0, len(base)+len(set))
	for _, e := range base {
		k, _, ok := strings.Cut(e, "=")
		if !ok || skip[k] {
			continue
		}
		out = append(out, e)
	}
	for k, v := range set {
		out = append(out, k+"="+v)
	}
	return out
}

func envValue(env []string, key string) string {
	prefix := key + "="
	for i := len(env) - 1; i >= 0; i-- {
		if strings.HasPrefix(env[i], prefix) {
			return env[i][len(prefix):]
		}
	}
	return ""
}

// successorEnv forces this process's settings addr and home onto the child.
// A sibling agent (test on :17891, production on :17890) must not inherit
// the other instance's listen address from a leftover CLI environment.
func successorEnv(base []string) []string {
	return overlayEnv(base, map[string]string{
		"FLEET_SETTINGS_ADDR": settingsAddr(),
		"FLEET_HOME":          fleetHome(),
	}, daemonStageEnv)
}

func successorArgs(args []string) []string {
	out := append([]string{}, args...)
	return out
}

func liveBinaryPath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}

func stagedBinaryPath(live string) string {
	if runtime.GOOS == "windows" {
		return strings.TrimSuffix(live, ".exe") + ".new.exe"
	}
	return live + ".new"
}

func backupBinaryPath(live string) string {
	if runtime.GOOS == "windows" {
		return strings.TrimSuffix(live, ".exe") + ".bak.exe"
	}
	return live + ".bak"
}

func buildRestartPlan(exe string, args, environ []string) (restartPlan, error) {
	if strings.TrimSpace(exe) == "" {
		return restartPlan{}, fmt.Errorf("restart: empty executable")
	}
	addr := settingsAddr()
	if !isLoopbackListenAddr(addr) {
		return restartPlan{}, fmt.Errorf("restart: refuse non-loopback settings addr %q", addr)
	}
	home := fleetHome()
	return restartPlan{
		Mode: restartModeSpawnThenExit,
		Exe:  exe,
		Args: successorArgs(args),
		Addr: addr,
		Home: home,
		Env:  successorEnv(environ),
	}, nil
}

func waitPortFree(addr string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var last error
	for time.Now().Before(deadline) {
		ln, err := net.Listen("tcp", addr)
		if err == nil {
			_ = ln.Close()
			return nil
		}
		last = err
		time.Sleep(20 * time.Millisecond)
	}
	if last == nil {
		last = fmt.Errorf("timeout")
	}
	return fmt.Errorf("settings port %s still busy: %w", addr, last)
}

func waitHTTP(addr string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	url := "http://" + addr + "/api/state"
	client := &http.Client{Timeout: 400 * time.Millisecond}
	var last error
	for time.Now().Before(deadline) {
		res, err := client.Get(url)
		if err == nil {
			res.Body.Close()
			if res.StatusCode == 200 {
				return nil
			}
			last = fmt.Errorf("http %s", res.Status)
		} else {
			last = err
		}
		time.Sleep(80 * time.Millisecond)
	}
	if last == nil {
		last = fmt.Errorf("timeout")
	}
	return fmt.Errorf("successor did not listen on %s: %w", addr, last)
}

func (s *settingsHTTP) serve(ln net.Listener, handler http.Handler) {
	srv := &http.Server{Handler: handler}
	s.mu.Lock()
	s.srv = srv
	s.ln = ln
	s.handler = handler
	s.addr = ln.Addr().String()
	s.mu.Unlock()
	err := srv.Serve(ln)
	if err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, net.ErrClosed) {
		log.Println("settings server:", err)
	}
}

func (s *settingsHTTP) close() {
	s.mu.Lock()
	srv := s.srv
	ln := s.ln
	s.srv = nil
	s.ln = nil
	s.mu.Unlock()
	if srv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		_ = srv.Shutdown(ctx)
		cancel()
	}
	if ln != nil {
		_ = ln.Close()
	}
}

func (s *settingsHTTP) reopen() error {
	s.mu.Lock()
	handler := s.handler
	s.mu.Unlock()
	if handler == nil {
		return fmt.Errorf("settings handler missing")
	}
	ln, err := net.Listen("tcp", settingsAddr())
	if err != nil {
		return err
	}
	go s.serve(ln, handler)
	return nil
}

func beginHandoff() bool {
	handoffMu.Lock()
	defer handoffMu.Unlock()
	if handoffBusy {
		return false
	}
	handoffBusy = true
	return true
}

func endHandoff() {
	handoffMu.Lock()
	handoffBusy = false
	handoffMu.Unlock()
}

func (a *Agent) wantsReconnectLocked() bool {
	return a.enabled && !a.restarting && strings.TrimSpace(a.hubInput) != "" && a.ws == nil && a.conn != "connecting"
}

func (a *Agent) beginRestartLocked() {
	a.restarting = true
}

func (a *Agent) endRestartLocked() {
	a.restarting = false
}

// handoffRestart stages a successor for this process's addr/home, then exits
// only after the successor is serving. exe is the binary to spawn (live or staged).
func (a *Agent) handoffRestart(exe string, extraEnv map[string]string) error {
	if !beginHandoff() {
		return fmt.Errorf("restart already in progress")
	}
	defer endHandoff()
	if strings.TrimSpace(exe) == "" {
		var err error
		exe, err = liveBinaryPath()
		if err != nil {
			return err
		}
	}
	plan, err := buildRestartPlan(exe, os.Args[1:], os.Environ())
	if err != nil {
		return err
	}
	if len(extraEnv) > 0 {
		plan.Env = overlayEnv(plan.Env, extraEnv)
	}

	a.save()
	a.mu.Lock()
	a.beginRestartLocked()
	a.disconnectLocked("restart")
	a.mu.Unlock()
	setKeepAlive(false)

	settingsNet.close()
	if err := waitPortFree(plan.Addr, 3*time.Second); err != nil {
		a.recoverAfterFailedHandoff(err.Error())
		return err
	}

	if err := spawnSuccessor(plan.Exe, plan.Args, plan.Env); err != nil {
		a.recoverAfterFailedHandoff("spawn: " + err.Error())
		return err
	}
	if err := waitHTTP(plan.Addr, 15*time.Second); err != nil {
		a.recoverAfterFailedHandoff(err.Error())
		return err
	}
	a.mu.Lock()
	a.log("info", "successor listening on "+plan.Addr)
	a.mu.Unlock()
	requestQuit()
	return nil
}

func (a *Agent) recoverAfterFailedHandoff(reason string) {
	a.mu.Lock()
	a.endRestartLocked()
	a.log("error", "restart failed: "+reason)
	a.mu.Unlock()
	if err := settingsNet.reopen(); err != nil {
		a.mu.Lock()
		a.log("error", "could not rebind settings: "+err.Error())
		a.mu.Unlock()
	} else {
		a.mu.Lock()
		a.log("warn", "rebound settings; this process stays up")
		a.mu.Unlock()
	}
	a.mu.Lock()
	on := a.enabled
	a.mu.Unlock()
	setKeepAlive(on)
	a.pushUI()
}

func (a *Agent) requestRestart() error {
	exe, err := liveBinaryPath()
	if err != nil {
		return err
	}
	return a.handoffRestart(exe, nil)
}

func maybePromoteBinary() {
	dest := strings.TrimSpace(os.Getenv(promoteEnvKey))
	if dest == "" {
		return
	}
	_ = os.Unsetenv(promoteEnvKey)
	src, err := os.Executable()
	if err != nil || src == "" || src == dest {
		return
	}
	for i := 0; i < 25; i++ {
		if err := copyFileReplace(src, dest); err == nil {
			return
		}
		time.Sleep(120 * time.Millisecond)
	}
}

func copyFileReplace(src, dest string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	tmp := dest + ".promoting"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	_, copyErr := copyStream(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		_ = os.Remove(tmp)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(tmp)
		return closeErr
	}
	_ = os.Remove(dest)
	if err := os.Rename(tmp, dest); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
