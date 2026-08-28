package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
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
		Actions:       []string{"configure", "profiles", "delegate"},
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
	m.Actions = nil
	if _, err := validateOfficialManifest(m); err != nil {
		t.Fatalf("legacy fleet.acp manifest rejected: %v", err)
	}
	m = testManifest()
	m.Publisher = "Someone Else"
	if _, err := validateOfficialManifest(m); err == nil {
		t.Fatal("untrusted publisher accepted")
	}
	m = testManifest()
	m.Artifacts[0].URL = "https://example.com/plugin"
	if _, err := validateOfficialManifest(m); err == nil {
		t.Fatal("untrusted URL accepted")
	}
	m = testManifest()
	m.Artifacts[0].URL = "https://github.com/TITOCHAN2023/other/releases/download/v0.1.0/fleet-acp-plugin"
	if _, err := validateOfficialManifest(m); err == nil {
		t.Fatal("artifact from a different repository accepted")
	}
	m = testManifest()
	m.Artifacts[0].URL = "https://github.com/TITOCHAN2023/fleet-acp-plugin/releases/download/v0.2.0/fleet-acp-plugin"
	if _, err := validateOfficialManifest(m); err == nil {
		t.Fatal("artifact from a different version accepted")
	}
	m = testManifest()
	m.ApprovalActions = []string{"undeclared"}
	if _, err := validateOfficialManifest(m); err == nil {
		t.Fatal("undeclared approval action accepted")
	}
}

func TestValidatePluginMirrorURLIsExactSameOrigin(t *testing.T) {
	good := "https://fleet.ginfo.cc/v1/plugin-artifact/fleet.transfer/0.1.0/" + runtime.GOOS + "/" + runtime.GOARCH
	if err := validatePluginMirrorURL(good, "fleet.transfer", "0.1.0", runtime.GOOS, runtime.GOARCH, "https://fleet.ginfo.cc"); err != nil {
		t.Fatal(err)
	}
	bad := []string{
		"https://evil.example/v1/plugin-artifact/fleet.transfer/0.1.0/" + runtime.GOOS + "/" + runtime.GOARCH,
		good + "?token=leak",
		"https://fleet.ginfo.cc/v1/plugin-artifact/fleet.transfer/0.2.0/" + runtime.GOOS + "/" + runtime.GOARCH,
		"https://fleet.ginfo.cc/v1/plugin-artifact/fleet.transfer/0.1.0/" + runtime.GOOS + "/other",
	}
	for _, raw := range bad {
		if err := validatePluginMirrorURL(raw, "fleet.transfer", "0.1.0", runtime.GOOS, runtime.GOARCH, "https://fleet.ginfo.cc"); err == nil {
			t.Fatalf("unsafe mirror accepted: %s", raw)
		}
	}
}

func TestLegacyPluginManifestDoesNotRequireMirror(t *testing.T) {
	m := testManifest()
	artifact, err := validateOfficialManifest(m)
	if err != nil {
		t.Fatal(err)
	}
	if artifact.MirrorURL != "" {
		t.Fatalf("legacy manifest unexpectedly acquired mirror %q", artifact.MirrorURL)
	}
}

func TestCleanPluginID(t *testing.T) {
	if got, err := cleanPluginID("fleet.acp"); err != nil || got != "fleet.acp" {
		t.Fatalf("%q %v", got, err)
	}
	for _, bad := range []string{"", ".", "..", ".fleet", "_fleet", "-fleet", "../fleet", "Fleet ACP", "/tmp/x"} {
		if _, err := cleanPluginID(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func TestPluginDirStaysBelowPluginRoot(t *testing.T) {
	home := t.TempDir()
	t.Setenv("FLEET_HOME", home)
	got, err := pluginDir("fleet.acp")
	want := filepath.Join(home, "plugins", "fleet.acp")
	if err != nil || got != want {
		t.Fatalf("pluginDir(fleet.acp) = %q, %v; want %q", got, err, want)
	}
	for _, bad := range []string{".", "..", ".hidden", "-leading", "_leading", "a/b", `a\b`, "/tmp/x"} {
		if _, err := pluginDir(bad); err == nil {
			t.Fatalf("pluginDir accepted %q", bad)
		}
	}
	root := filepath.Join(home, "plugins")
	for _, bad := range []string{"", ".", "..", "../escape", "a/b", `a\b`} {
		if _, err := containedPluginDir(root, bad); err == nil {
			t.Fatalf("containment boundary accepted %q", bad)
		}
	}
}

func TestCleanPluginActionRejectsPrototypeKey(t *testing.T) {
	if _, err := cleanPluginAction("__proto__"); err == nil {
		t.Fatal("prototype-polluting action key accepted")
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
	if !strings.Contains(configure, "codex-acp") {
		t.Fatalf("opaque configure consent: %q", configure)
	}
	delegate := pluginConsentText(pluginRequest{Operation: "invoke", PluginID: "fleet.acp", Action: "delegate", Input: json.RawMessage(`{"cwd":"/work/project","prompt":"fix the tests"}`)})
	if !strings.Contains(delegate, "/work/project") || !strings.Contains(delegate, "fix the tests") {
		t.Fatalf("opaque delegate consent: %q", delegate)
	}
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

func installPluginTestBinary(t *testing.T) installedPlugin {
	t.Helper()
	home := t.TempDir()
	t.Setenv("FLEET_HOME", home)
	dir, err := pluginDir("fleet.transfer")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	entrypoint := "fleet-transfer-plugin"
	if runtime.GOOS == "windows" {
		entrypoint += ".exe"
	}
	target := filepath.Join(dir, entrypoint)
	source, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	in, err := os.Open(source)
	if err != nil {
		t.Fatal(err)
	}
	out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o700)
	if err != nil {
		_ = in.Close()
		t.Fatal(err)
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = in.Close()
		_ = out.Close()
		t.Fatal(err)
	}
	if err := in.Close(); err != nil {
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(b)
	meta := installedPlugin{
		ID:              "fleet.transfer",
		Name:            "Fleet Transfer",
		Version:         "0.1.0",
		Publisher:       "Fleet Official",
		License:         "MIT",
		Repository:      "https://github.com/TITOCHAN2023/fleet-transfer-plugin",
		ArtifactURL:     "https://github.com/TITOCHAN2023/fleet-transfer-plugin/releases/download/v0.1.0/" + entrypoint,
		SHA256:          fmt.Sprintf("%x", sum),
		Entrypoint:      entrypoint,
		Actions:         []string{"prepare_source", "prepare_target", "hang"},
		ApprovalActions: []string{"prepare_source", "prepare_target"},
		InstalledAt:     time.Now().UnixMilli(),
	}
	if err := writePluginMeta(dir, meta); err != nil {
		t.Fatal(err)
	}
	return meta
}

func TestInstalledMetadataPreservesLegacyACPActions(t *testing.T) {
	t.Setenv("FLEET_HOME", t.TempDir())
	dir, err := pluginDir("fleet.acp")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	legacy := installedPlugin{ID: "fleet.acp", Name: "Fleet ACP", Version: "0.1.0", Publisher: "Fleet Official", License: "MIT", Repository: "https://github.com/TITOCHAN2023/fleet-acp-plugin", SHA256: strings.Repeat("a", 64), Entrypoint: "fleet-acp-plugin"}
	if err := writePluginMeta(dir, legacy); err != nil {
		t.Fatal(err)
	}
	meta, err := installedPluginMetadata("fleet.acp")
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(meta.Actions, ","); got != "configure,profiles,delegate" {
		t.Fatalf("legacy actions=%q", got)
	}
}

func TestInstalledPluginEnforcesActionAllowlistAndApproval(t *testing.T) {
	installPluginTestBinary(t)
	if _, _, err := installedPluginForAction("fleet.transfer", "prepare_source"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := installedPluginForAction("fleet.transfer", "delete_everything"); err == nil {
		t.Fatal("undeclared action accepted")
	}
	if ask, err := pluginActionRequiresApproval("fleet.transfer", "prepare_source"); err != nil || !ask {
		t.Fatalf("source approval=(%v, %v)", ask, err)
	}
	if ask, err := pluginActionRequiresApproval("fleet.transfer", "hang"); err != nil || ask {
		t.Fatalf("hang approval=(%v, %v)", ask, err)
	}
}

func TestPeerRuntimeEnvelopeSeparatesTaskAndPeerActions(t *testing.T) {
	meta := installPluginTestBinary(t)
	meta.ActionSpecs = map[string]pluginActionSpec{
		"prepare_source": {Runtime: pluginRuntimePeer, Role: "source"},
		"prepare_target": {Runtime: pluginRuntimePeer, Role: "target"},
		"hang":           {Runtime: pluginRuntimeTask},
	}
	meta.PeerProtocols = []pluginPeerProtocol{{
		ID: "example.bytes.v1", ABI: pluginPeerABI, Transport: "direct_ordered", Approval: "both_once",
		Roles: map[string]string{"source": "prepare_source", "target": "prepare_target"},
	}}
	dir, err := pluginDir(meta.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := writePluginMeta(dir, meta); err != nil {
		t.Fatal(err)
	}
	if _, _, err := installedPluginForPeerAction(meta.ID, "example.bytes.v1", "source", "prepare_source"); err == nil || !strings.Contains(err.Error(), "task runtime") {
		t.Fatalf("task envelope exposed a peer capability: %v", err)
	}
	meta.Runtime = pluginRuntimePeer
	if err := writePluginMeta(dir, meta); err != nil {
		t.Fatal(err)
	}
	if _, _, err := installedPluginForTaskAction(meta.ID, "prepare_source"); err == nil || !strings.Contains(err.Error(), "peer runtime") {
		t.Fatalf("peer action reached task runtime: %v", err)
	}
	if _, _, err := installedPluginForTaskAction(meta.ID, "hang"); err != nil {
		t.Fatalf("task action rejected: %v", err)
	}
	if _, _, err := installedPluginForPeerAction(meta.ID, "example.bytes.v1", "source", "prepare_source"); err != nil {
		t.Fatalf("peer action rejected by peer runtime: %v", err)
	}
}

func TestNormalizePluginPeerDeclarationsMatchesRegistryClosure(t *testing.T) {
	actions := []string{"source", "target", "inspect"}
	specs := map[string]pluginActionSpec{
		"source":  {Runtime: pluginRuntimePeer, Role: "source"},
		"target":  {Runtime: pluginRuntimePeer, Role: "target"},
		"inspect": {Runtime: pluginRuntimeTask},
	}
	protocols := []pluginPeerProtocol{{
		ID: "example.bytes.v1", ABI: pluginPeerABI, Transport: "direct_ordered", Approval: "both_once",
		Roles: map[string]string{"source": "source", "target": "target"},
	}}
	if _, _, _, err := normalizePluginPeerDeclarations(pluginRuntimePeer, actions, specs, protocols); err != nil {
		t.Fatalf("valid hybrid peer envelope rejected: %v", err)
	}

	tests := []struct {
		name      string
		runtime   string
		actions   []string
		specs     map[string]pluginActionSpec
		protocols []pluginPeerProtocol
		want      string
	}{
		{
			name: "task envelope with peer capability", runtime: pluginRuntimeTask,
			actions: actions, specs: specs, protocols: protocols, want: "task runtime",
		},
		{
			name: "partial action specs", runtime: pluginRuntimePeer, actions: actions,
			specs: map[string]pluginActionSpec{
				"source": {Runtime: pluginRuntimePeer, Role: "source"},
				"target": {Runtime: pluginRuntimePeer, Role: "target"},
			},
			protocols: protocols, want: "every declared action",
		},
		{
			name: "peer envelope without protocol", runtime: pluginRuntimePeer,
			actions: []string{"inspect"}, specs: nil, protocols: nil, want: "requires peer_protocols",
		},
		{
			name: "missing action runtime", runtime: pluginRuntimePeer, actions: []string{"source", "target"},
			specs: map[string]pluginActionSpec{
				"source": {Role: "source"},
				"target": {Runtime: pluginRuntimePeer, Role: "target"},
			},
			protocols: protocols, want: "requires a runtime",
		},
		{
			name: "non-registry protocol id", runtime: pluginRuntimePeer, actions: actions, specs: specs,
			protocols: []pluginPeerProtocol{{
				ID: "Example/bytes", ABI: pluginPeerABI, Transport: "direct_ordered", Approval: "both_once",
				Roles: map[string]string{"source": "source", "target": "target"},
			}}, want: "invalid peer protocol",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, _, err := normalizePluginPeerDeclarations(tt.runtime, tt.actions, tt.specs, tt.protocols)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error=%v, want %q", err, tt.want)
			}
		})
	}
}

func TestInstalledPluginRejectsTamperedEntrypoint(t *testing.T) {
	meta := installPluginTestBinary(t)
	dir, err := pluginDir(meta.ID)
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(filepath.Join(dir, meta.Entrypoint), os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte("tampered")); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := installedPluginForAction(meta.ID, "prepare_source"); err == nil || !strings.Contains(err.Error(), "SHA-256 mismatch") {
		t.Fatalf("tampered plugin error=%v", err)
	}
}
