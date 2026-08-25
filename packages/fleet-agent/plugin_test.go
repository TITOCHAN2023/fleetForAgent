package main

import (
	"encoding/json"
	"runtime"
	"strings"
	"testing"
)

func testManifest() pluginManifest {
	name := "fleet-acp-plugin"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return pluginManifest{
		SchemaVersion: 1,
		ID:            "fleet.acp",
		Name:          "Fleet ACP",
		Version:       "0.1.0",
		Publisher:     "Fleet Official",
		License:       "MIT",
		Repository:    "https://github.com/TITOCHAN2023/fleet-acp-plugin",
		Artifacts: []pluginArtifact{{
			OS: runtime.GOOS, Arch: runtime.GOARCH,
			URL:    "https://github.com/TITOCHAN2023/fleet-acp-plugin/releases/download/v0.1.0/fleet-acp-plugin",
			SHA256: strings.Repeat("a", 64), Entrypoint: name,
		}},
	}
}

func TestValidateOfficialManifest(t *testing.T) {
	m := testManifest()
	if _, err := validateOfficialManifest(m); err != nil {
		t.Fatal(err)
	}
	m.Publisher = "Someone Else"
	if _, err := validateOfficialManifest(m); err == nil {
		t.Fatal("untrusted publisher accepted")
	}
	m = testManifest()
	m.Artifacts[0].URL = "https://example.com/plugin"
	if _, err := validateOfficialManifest(m); err == nil {
		t.Fatal("untrusted URL accepted")
	}
}

func TestCleanPluginID(t *testing.T) {
	if got, err := cleanPluginID("fleet.acp"); err != nil || got != "fleet.acp" {
		t.Fatalf("%q %v", got, err)
	}
	for _, bad := range []string{"", "../fleet", "Fleet ACP", "/tmp/x"} {
		if _, err := cleanPluginID(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func TestDecodePluginRequest(t *testing.T) {
	req, err := decodePluginRequest(map[string]any{
		"operation": "invoke", "plugin_id": "fleet.acp", "action": "profiles",
		"input": map[string]any{"profile": "default"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if req.Operation != "invoke" || req.PluginID != "fleet.acp" || !json.Valid(req.Input) {
		t.Fatalf("bad request: %#v", req)
	}
}

func TestPluginConsentExplainsACPAction(t *testing.T) {
	configure := pluginConsentText(pluginRequest{Operation: "invoke", PluginID: "fleet.acp", Action: "configure", Input: json.RawMessage(`{"command":"codex-acp"}`)})
	if !strings.Contains(configure, "codex-acp") { t.Fatalf("opaque configure consent: %q", configure) }
	delegate := pluginConsentText(pluginRequest{Operation: "invoke", PluginID: "fleet.acp", Action: "delegate", Input: json.RawMessage(`{"cwd":"/work/project","prompt":"fix the tests"}`)})
	if !strings.Contains(delegate, "/work/project") || !strings.Contains(delegate, "fix the tests") { t.Fatalf("opaque delegate consent: %q", delegate) }
}

func TestSoftwareChangesAlwaysAsk(t *testing.T) {
	a := &Agent{enabled: true, permit: PermitAllow}
	if v, _ := a.inputVerdict(); v != permitProceed {
		t.Fatalf("baseline verdict=%v", v)
	}
	// handlePlugin upgrades proceed to ask for install/uninstall; the invariant is
	// represented independently here so permit=allow stays valid for invocations.
	for _, op := range []string{"install", "uninstall"} {
		if !pluginSoftwareChange(op) {
			t.Fatalf("%s should be a software change", op)
		}
	}
}
