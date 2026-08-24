package main

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestDecideUpdateArm(t *testing.T) {
	now := time.Date(2026, 8, 24, 3, 0, 0, 0, time.UTC)
	fresh := versionSignal{Version: "0.3.2", Seen: now.Add(-2 * time.Minute)}
	stale := versionSignal{Version: "0.3.2", Seen: now.Add(-11 * time.Minute)}
	same := versionSignal{Version: "0.3.1", Seen: now}

	cases := []struct {
		name  string
		idle  bool
		sig   versionSignal
		want  string
		armed bool
	}{
		{"idle fresh", true, fresh, "armed", true},
		{"busy", false, fresh, "busy", false},
		{"stale 11m", true, stale, "stale", false},
		{"not newer", true, same, "not_newer", false},
		{"no signal", true, versionSignal{}, "no_signal", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := decideUpdateArm(tc.idle, "0.3.1", tc.sig, now, 10*time.Minute)
			if d.Armed != tc.armed || d.Reason != tc.want {
				t.Fatalf("got armed=%v reason=%q want armed=%v reason=%q", d.Armed, d.Reason, tc.armed, tc.want)
			}
		})
	}
}

func TestParseVersionSignal(t *testing.T) {
	now := time.Now()
	if _, ok := parseVersionSignal(map[string]any{"heartbeat_s": 25}, now); ok {
		t.Fatal("hello_ok without latest_agent_ver is not a signal")
	}
	sig, ok := parseVersionSignal(map[string]any{
		"latest_agent_ver": "0.3.2",
		"update_base":      "http://127.0.0.1:9",
		"update_sha256":    "ABC",
	}, now)
	if !ok || sig.Version != "0.3.2" || sig.Base != "http://127.0.0.1:9" || sig.SHA256 != "abc" {
		t.Fatalf("%+v", sig)
	}
}

func TestAcceptUpdateClickRequiresArm(t *testing.T) {
	a := &Agent{panes: newSupervisor(), enabled: true}
	if err := acceptUpdateClick(a, updateRequest{}); err != errUpdateNotArmed {
		t.Fatalf("got %v", err)
	}
	a.updateSig = versionSignal{Version: "0.3.2", Seen: time.Now()}
	if !a.updateArmedNow() {
		t.Fatal("fresh newer signal + idle should arm")
	}
	a.pending = &Pending{Command: "sleep 1"}
	if a.updateArmedNow() {
		t.Fatal("busy must hide the button")
	}
	if err := acceptUpdateClick(a, updateRequest{}); err != errUpdateNotArmed {
		t.Fatalf("busy click: %v", err)
	}
}

func TestSnapshotOmitsAutoUpdateToggle(t *testing.T) {
	home := t.TempDir()
	t.Setenv("FLEET_HOME", home)
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	writeJSONFile(t, configPath(), map[string]any{
		"enabled": true, "permit": "ask", "hubInput": "", "hubToken": "", "deviceId": "abc",
		"autoUpdate": false,
	})
	a := &Agent{cfgPath: configPath(), panes: newSupervisor()}
	a.load()
	s := a.snapshot()
	b, _ := json.Marshal(s)
	if string(b) == "" || containsJSONKey(b, "autoUpdate") {
		t.Fatalf("state must not advertise an auto-apply toggle: %s", b)
	}
	if s.Update.Armed {
		t.Fatal("no heartbeat signal: button must stay hidden")
	}
}

func containsJSONKey(b []byte, key string) bool {
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return false
	}
	_, ok := m[key]
	return ok
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
