package main

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/TITOCHAN2023/fleetForAgent/internal/pane"
)

func TestDecideAutoUpdate(t *testing.T) {
	now := time.Date(2026, 8, 24, 3, 0, 0, 0, time.UTC)
	fresh := versionSignal{Version: "0.3.2", Seen: now.Add(-2 * time.Minute)}
	stale := versionSignal{Version: "0.3.2", Seen: now.Add(-11 * time.Minute)}
	same := versionSignal{Version: "0.3.1", Seen: now}

	cases := []struct {
		name   string
		toggle bool
		idle   bool
		sig    versionSignal
		want   string
		apply  bool
	}{
		{"on idle fresh", true, true, fresh, "apply", true},
		{"toggle off", false, true, fresh, "toggle_off", false},
		{"busy", true, false, fresh, "busy", false},
		{"stale 11m", true, true, stale, "stale", false},
		{"not newer", true, true, same, "not_newer", false},
		{"no signal", true, true, versionSignal{}, "no_signal", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := decideAutoUpdate(tc.toggle, tc.idle, "0.3.1", tc.sig, now, 10*time.Minute)
			if d.Apply != tc.apply || d.Reason != tc.want {
				t.Fatalf("got apply=%v reason=%q want apply=%v reason=%q", d.Apply, d.Reason, tc.apply, tc.want)
			}
		})
	}
}

func TestParseVersionSignalIgnoresHubUpdateSource(t *testing.T) {
	now := time.Now()
	if _, ok := parseVersionSignal(map[string]any{"heartbeat_s": 25}, now); ok {
		t.Fatal("hello_ok without latest_agent_ver is not a signal")
	}
	sig, ok := parseVersionSignal(map[string]any{
		"latest_agent_ver": "0.3.2",
		"update_base":      "https://attacker.example/releases",
		"update_url":       "https://attacker.example/fleet-agent",
		"update_sha256":    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	}, now)
	if !ok || sig.Version != "0.3.2" || !sig.Seen.Equal(now) {
		t.Fatalf("%+v", sig)
	}
}

func TestLoadMissingAutoUpdateDefaultsOff(t *testing.T) {
	home := t.TempDir()
	t.Setenv("FLEET_HOME", home)
	t.Setenv("FLEET_AUTO_UPDATE", "")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	writeJSONFile(t, configPath(), map[string]any{
		"enabled": true, "permit": "ask", "hubInput": "", "hubToken": "", "deviceId": "abc",
	})
	a := &Agent{cfgPath: configPath(), panes: pane.NewSupervisor()}
	a.load()
	if a.autoUpdate {
		t.Fatal("missing autoUpdate key must default off")
	}
	s := a.snapshot()
	if s.AutoUpdate {
		t.Fatal("state.autoUpdate must be off")
	}
}

func TestLoadNewInstallDefaultsAutoUpdateOff(t *testing.T) {
	home := t.TempDir()
	t.Setenv("FLEET_HOME", home)
	t.Setenv("FLEET_AUTO_UPDATE", "")
	a := &Agent{cfgPath: configPath(), panes: pane.NewSupervisor()}
	a.load()
	if a.autoUpdate {
		t.Fatal("a new install must default auto-update off")
	}
}

func TestLoadAutoUpdateExplicitOnPersists(t *testing.T) {
	home := t.TempDir()
	t.Setenv("FLEET_HOME", home)
	t.Setenv("FLEET_AUTO_UPDATE", "")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	writeJSONFile(t, configPath(), map[string]any{
		"enabled": true, "permit": "ask", "hubInput": "", "hubToken": "", "deviceId": "abc",
		"autoUpdate": true,
	})
	a := &Agent{cfgPath: configPath(), panes: pane.NewSupervisor()}
	a.load()
	if !a.autoUpdate {
		t.Fatal("explicit autoUpdate=true must stay on")
	}
}

func TestLoadAutoUpdateEnvCanOptIn(t *testing.T) {
	home := t.TempDir()
	t.Setenv("FLEET_HOME", home)
	t.Setenv("FLEET_AUTO_UPDATE", "true")
	a := &Agent{cfgPath: configPath(), panes: pane.NewSupervisor()}
	a.load()
	if !a.autoUpdate {
		t.Fatal("FLEET_AUTO_UPDATE=true must opt in")
	}
}

func TestLoadAutoUpdateOffPersists(t *testing.T) {
	home := t.TempDir()
	t.Setenv("FLEET_HOME", home)
	t.Setenv("FLEET_AUTO_UPDATE", "")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	writeJSONFile(t, configPath(), map[string]any{
		"enabled": true, "permit": "ask", "hubInput": "", "hubToken": "", "deviceId": "abc",
		"autoUpdate": false,
	})
	a := &Agent{cfgPath: configPath(), panes: pane.NewSupervisor()}
	a.load()
	if a.autoUpdate {
		t.Fatal("explicit autoUpdate=false must stay off")
	}
}

func writeJSONFile(t *testing.T, path string, v any) {
	t.Helper()
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
}
