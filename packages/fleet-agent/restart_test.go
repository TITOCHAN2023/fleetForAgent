package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSuccessorEnvUsesThisProcessAddrAndHome(t *testing.T) {
	home := filepath.Join(t.TempDir(), "fleet-agent-test")
	t.Setenv("FLEET_SETTINGS_ADDR", "127.0.0.1:17891")
	t.Setenv("FLEET_HOME", home)

	sibling := []string{
		"PATH=/usr/bin",
		"FLEET_SETTINGS_ADDR=127.0.0.1:17890",
		"FLEET_HOME=/tmp/.fleet-agent",
		"FLEET_TOKEN=do-not-log",
		daemonStageEnv + "=2",
	}
	env := successorEnv(sibling)
	if got := envValue(env, "FLEET_SETTINGS_ADDR"); got != "127.0.0.1:17891" {
		t.Fatalf("settings addr=%q; sibling 17890 must not win", got)
	}
	if got := envValue(env, "FLEET_HOME"); got != home {
		t.Fatalf("home=%q want %q", got, home)
	}
	if envValue(env, daemonStageEnv) != "" {
		t.Fatal("successor must not inherit daemon stage")
	}
	if envValue(env, "FLEET_TOKEN") != "do-not-log" {
		t.Fatal("token env must still be inherited, just never printed")
	}
}

func TestRestartPlanIsSpawnThenExit(t *testing.T) {
	home := t.TempDir()
	t.Setenv("FLEET_SETTINGS_ADDR", "127.0.0.1:17891")
	t.Setenv("FLEET_HOME", home)
	plan, err := buildRestartPlan("/opt/FleetAgent", []string{"--daemon"}, os.Environ())
	if err != nil {
		t.Fatal(err)
	}
	if plan.Mode != restartModeSpawnThenExit {
		t.Fatalf("mode=%q; restart is not quit-and-hope", plan.Mode)
	}
	if plan.Mode == "quit" {
		t.Fatal("restart must not be quit")
	}
	if plan.Addr != "127.0.0.1:17891" || plan.Home != home {
		t.Fatalf("plan addr/home = %q %q", plan.Addr, plan.Home)
	}
	if plan.Exe != "/opt/FleetAgent" {
		t.Fatalf("exe=%q", plan.Exe)
	}
	if envValue(plan.Env, "FLEET_SETTINGS_ADDR") != "127.0.0.1:17891" {
		t.Fatal("plan env lost this process listen addr")
	}
}

func TestRestartPlanRejectsNonLoopback(t *testing.T) {
	t.Setenv("FLEET_SETTINGS_ADDR", "0.0.0.0:17890")
	if _, err := buildRestartPlan("/bin/true", nil, nil); err == nil {
		t.Fatal("expected error")
	}
}

func TestStagedAndBackupPaths(t *testing.T) {
	if runtime.GOOS == "windows" {
		if got := stagedBinaryPath(`C:\Fleet\FleetAgent.exe`); got != `C:\Fleet\FleetAgent.new.exe` {
			t.Fatalf("staged=%q", got)
		}
		if got := backupBinaryPath(`C:\Fleet\FleetAgent.exe`); got != `C:\Fleet\FleetAgent.bak.exe` {
			t.Fatalf("bak=%q", got)
		}
		return
	}
	if got := stagedBinaryPath("/Applications/Fleet Agent.app/Contents/MacOS/FleetAgent"); !strings.HasSuffix(got, "FleetAgent.new") {
		t.Fatalf("staged=%q", got)
	}
	if got := backupBinaryPath("/opt/fleet-agent"); got != "/opt/fleet-agent.bak" {
		t.Fatalf("bak=%q", got)
	}
}

func TestLoadKeepsDeviceIDAndPermit(t *testing.T) {
	home := t.TempDir()
	t.Setenv("FLEET_HOME", home)
	t.Setenv("FLEET_URL", "")
	t.Setenv("FLEET_TOKEN", "")
	t.Setenv("FLEET_ENABLED", "")
	want := "0af361d05eee4e15a344fdab312c25a9"
	cfg := map[string]any{
		"enabled":  true,
		"permit":   "allow",
		"hubInput": "https://fleet.ginfo.cc",
		"hubToken": "flt_test_token",
		"deviceId": want,
	}
	b, _ := json.MarshalIndent(cfg, "", "  ")
	if err := os.WriteFile(configPath(), b, 0o600); err != nil {
		t.Fatal(err)
	}
	a := &Agent{cfgPath: configPath()}
	a.load()
	if a.deviceID != want {
		t.Fatalf("deviceID=%q want %q (must not mint a new id)", a.deviceID, want)
	}
	if a.permit != PermitAllow {
		t.Fatalf("permit=%q", a.permit)
	}
	if !a.autoUpdate {
		t.Fatal("missing autoUpdate key must default on")
	}
	if a.hubInput != "https://fleet.ginfo.cc" {
		t.Fatalf("hub=%q", a.hubInput)
	}
}

func TestWantsReconnect(t *testing.T) {
	a := &Agent{enabled: true, hubInput: "https://hub.example", conn: "offline"}
	if !a.wantsReconnectLocked() {
		t.Fatal("offline enabled agent should reconnect")
	}
	a.restarting = true
	if a.wantsReconnectLocked() {
		t.Fatal("must not reconnect during restart handoff")
	}
	a.restarting = false
	a.enabled = false
	if a.wantsReconnectLocked() {
		t.Fatal("disabled agent must stay down")
	}
	a.enabled = true
	a.hubInput = ""
	if a.wantsReconnectLocked() {
		t.Fatal("no hub: do not reconnect")
	}
	a.hubInput = "https://hub.example"
	a.conn = "offline"
	a.authRevoked = true
	if a.wantsReconnectLocked() {
		t.Fatal("revoked token must be a terminal state until replaced")
	}
}

func TestHelpListsRestartUpdateRollback(t *testing.T) {
	text := helpText()
	for _, cmd := range []string{"fleet restart", "fleet update", "fleet rollback"} {
		if !strings.Contains(text, cmd) {
			t.Fatalf("help missing %s:\n%s", cmd, text)
		}
	}
	if !strings.Contains(text, "this process respawns on its own listen addr") {
		t.Fatal("help should say restart targets this process")
	}
	if !strings.Contains(text, "fleet autoupdate") {
		t.Fatal("help missing autoupdate")
	}
}
