package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const apiRoot = "http://127.0.0.1:17890"

func isCLICommand(name string) bool {
	switch name {
	case "help", "-h", "--help", "version", "--version",
		"status", "start", "stop", "quit",
		"enable", "disable", "permit", "connect",
		"approve", "deny", "install":
		return true
	default:
		return false
	}
}

func runCLI(args []string) int {
	initCLIStdio()
	cmd, rest := args[0], args[1:]
	var err error
	switch cmd {
	case "help", "-h", "--help":
		printHelp()
		return 0
	case "version", "--version":
		fmt.Println("fleet", agentVersion)
		return 0
	case "status":
		err = cliStatus(rest)
	case "start":
		err = cliStart(rest)
	case "stop":
		err = cliStop()
	case "quit":
		err = cliQuit()
	case "enable":
		err = cliEnabled(true)
	case "disable":
		err = cliEnabled(false)
	case "permit":
		err = cliPermit(rest)
	case "connect":
		err = cliConnect(rest)
	case "approve":
		err = cliPost("/api/approve", nil)
	case "deny":
		err = cliPost("/api/deny", nil)
	case "install":
		err = cliInstall()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", cmd)
		printHelp()
		return 2
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

func printHelp() {
	fmt.Print(`Fleet Agent — same process as the tray / settings UI.

Commands talk to the local agent at 127.0.0.1:17890. If the agent is
running, CLI and UI share one state. Do not edit config.json while it runs.

  fleet start [--hub URL] [--token TOKEN] [--permit off|ask|allow]
  fleet stop                 disable (daemon stays in the tray)
  fleet quit                 exit the daemon
  fleet status [--json]
  fleet enable | disable
  fleet permit off|ask|allow
  fleet connect [hub] [--token TOKEN]
  fleet approve | deny
  fleet install              put "fleet" on PATH
  fleet help

Linux has no settings page: use these commands or the tray.
Start the daemon with:  fleet start   or   fleet --daemon
`)
}

func cliStatus(args []string) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	asJSON := fs.Bool("json", false, "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	st, err := liveState()
	if err != nil {
		fmt.Println("running: no")
		fmt.Println("hint: fleet start")
		return nil
	}
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(st)
	}
	fmt.Println("running: yes")
	fmt.Println("enabled:", st.Enabled)
	fmt.Println("conn:   ", st.Conn)
	fmt.Println("permit: ", st.Permit)
	fmt.Println("device: ", st.DeviceID)
	fmt.Println("hub:    ", emptyDash(st.HubInput))
	fmt.Println("token:  ", tokenMark(st.HubToken))
	if st.Error != "" {
		fmt.Println("error:  ", st.Error)
	}
	if st.Pending != nil {
		fmt.Println("pending:", st.Pending.Command)
	}
	return nil
}

func cliStart(args []string) error {
	fs := flag.NewFlagSet("start", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	hub := fs.String("hub", "", "hub URL")
	token := fs.String("token", "", "hub token")
	permit := fs.String("permit", "", "off|ask|allow")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *hub == "" {
		*hub = firstNonEmpty(os.Getenv("FLEET_URL"), os.Getenv("FLEET_HUB"))
	}
	if *token == "" {
		*token = firstNonEmpty(os.Getenv("FLEET_TOKEN"), os.Getenv("FLEET_HUB_TOKEN"))
	}
	if !agentRunning() {
		if err := writeOfflineStart(*hub, *token, *permit); err != nil {
			return err
		}
		if err := spawnDaemon(); err != nil {
			return err
		}
		if err := waitReady(12 * time.Second); err != nil {
			return err
		}
	}
	if *permit != "" {
		if err := postJSON("/api/permit", map[string]string{"permit": *permit}); err != nil {
			return err
		}
	}
	if err := postJSON("/api/enabled", map[string]bool{"enabled": true}); err != nil {
		return err
	}
	body := map[string]string{}
	if *hub != "" {
		body["hub"] = *hub
	}
	if *token != "" {
		body["token"] = *token
	}
	if err := postJSON("/api/connect", body); err != nil {
		return err
	}
	waitConn(5 * time.Second)
	return cliStatus(nil)
}

func cliStop() error {
	if !agentRunning() {
		return fmt.Errorf("agent not running")
	}
	return postJSON("/api/enabled", map[string]bool{"enabled": false})
}

func cliQuit() error {
	if !agentRunning() {
		fmt.Println("agent not running")
		return nil
	}
	_ = postJSON("/api/quit", map[string]string{})
	return nil
}

func cliEnabled(on bool) error {
	if !agentRunning() {
		return fmt.Errorf("agent not running; fleet start")
	}
	return postJSON("/api/enabled", map[string]bool{"enabled": on})
}

func cliPermit(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: fleet permit off|ask|allow")
	}
	p := args[0]
	if p != "off" && p != "ask" && p != "allow" {
		return fmt.Errorf("permit must be off, ask, or allow")
	}
	if !agentRunning() {
		return fmt.Errorf("agent not running; fleet start")
	}
	return postJSON("/api/permit", map[string]string{"permit": p})
}

func cliConnect(args []string) error {
	fs := flag.NewFlagSet("connect", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	token := fs.String("token", "", "hub token")
	if err := fs.Parse(args); err != nil {
		return err
	}
	hub := fs.Arg(0)
	if !agentRunning() {
		return fmt.Errorf("agent not running; fleet start")
	}
	body := map[string]string{}
	if hub != "" {
		body["hub"] = hub
	}
	if *token != "" {
		body["token"] = *token
	}
	if err := postJSON("/api/connect", body); err != nil {
		return err
	}
	waitConn(5 * time.Second)
	return cliStatus(nil)
}

func cliPost(path string, body any) error {
	if !agentRunning() {
		return fmt.Errorf("agent not running; fleet start")
	}
	return postJSON(path, body)
}

func cliInstall() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		dir := filepath.Join(os.Getenv("LOCALAPPDATA"), "Fleet")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		dest := filepath.Join(dir, "fleet.exe")
		in, err := os.ReadFile(exe)
		if err != nil {
			return err
		}
		if err := os.WriteFile(dest, in, 0o755); err != nil {
			return err
		}
		fmt.Println("installed", dest)
		fmt.Println("add that folder to PATH, then: fleet status")
		return nil
	}
	dest := "/usr/local/bin/fleet"
	if err := os.Remove(dest); err != nil && !os.IsNotExist(err) {
		// keep going; symlink may replace
	}
	if err := os.Symlink(exe, dest); err != nil {
		fmt.Fprintf(os.Stderr, "need write access to %s\n", dest)
		fmt.Fprintf(os.Stderr, "run: sudo ln -sf %q %s\n", exe, dest)
		return err
	}
	fmt.Println("installed", dest, "->", exe)
	return nil
}

func liveState() (State, error) {
	client := &http.Client{Timeout: time.Second}
	res, err := client.Get(apiRoot + "/api/state")
	if err != nil {
		return State{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return State{}, fmt.Errorf("agent http %s", res.Status)
	}
	var st State
	if err := json.NewDecoder(res.Body).Decode(&st); err != nil {
		return State{}, err
	}
	return st, nil
}

func agentRunning() bool {
	_, err := liveState()
	return err == nil
}

func waitReady(d time.Duration) error {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if agentRunning() {
			return nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	return fmt.Errorf("agent did not come up on %s", settingsAddr)
}

func waitConn(d time.Duration) {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		st, err := liveState()
		if err == nil && (st.Conn == "online" || st.Conn == "error") {
			return
		}
		time.Sleep(150 * time.Millisecond)
	}
}

func postJSON(path string, body any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}
	client := &http.Client{Timeout: 5 * time.Second}
	res, err := client.Post(apiRoot+path, "application/json", rdr)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		slurp, _ := io.ReadAll(res.Body)
		return fmt.Errorf("%s: %s %s", path, res.Status, bytes.TrimSpace(slurp))
	}
	return nil
}

func writeOfflineStart(hub, token, permit string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	dir := filepath.Join(home, ".fleet-agent")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(dir, "config.json")
	cfg := map[string]any{
		"enabled":  true,
		"permit":   "ask",
		"hubInput": "",
		"hubToken": "",
		"deviceId": "",
	}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &cfg)
	}
	cfg["enabled"] = true
	if hub != "" {
		cfg["hubInput"] = hub
	}
	if token != "" {
		cfg["hubToken"] = token
	}
	if permit == "off" || permit == "ask" || permit == "allow" {
		cfg["permit"] = permit
	}
	if s, _ := cfg["deviceId"].(string); s == "" {
		cfg["deviceId"] = newDeviceID()
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}

func spawnDaemon() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "--daemon")
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.SysProcAttr = detachAttr()
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}

func emptyDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "-"
	}
	return s
}

func tokenMark(s string) string {
	if strings.TrimSpace(s) == "" {
		return "missing"
	}
	return "set"
}
