package main

import (
	"bufio"
	"bytes"
	"context"
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

const pluginStreamHelperEnv = "GO_WANT_FLEET_PLUGIN_STREAM_HELPER"

func TestMain(m *testing.M) {
	if os.Getenv(pluginStreamHelperEnv) == "1" {
		os.Exit(runPluginStreamHelper())
	}
	os.Exit(m.Run())
}

func runPluginStreamHelper() int {
	r := bufio.NewReader(os.Stdin)
	line, err := r.ReadBytes('\n')
	if err != nil {
		return 2
	}
	var req struct {
		Action string `json:"action"`
	}
	if json.Unmarshal(line, &req) != nil {
		return 2
	}
	switch req.Action {
	case "prepare_source":
		_, _ = fmt.Fprintln(os.Stdout, `{"ok":true,"size":3145728}`)
		chunk := bytes.Repeat([]byte("x"), 32<<10)
		for i := 0; i < 96; i++ {
			if _, err := os.Stdout.Write(chunk); err != nil {
				return 3
			}
		}
	case "prepare_target":
		n, err := io.Copy(io.Discard, r)
		if err != nil {
			return 3
		}
		_, _ = fmt.Fprintf(os.Stdout, "{\"committed\":%d}\n{\"done\":true}\n", n)
	case "hang":
		time.Sleep(10 * time.Minute)
	default:
		return 4
	}
	return 0
}

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
	if !strings.Contains(configure, "codex-acp") {
		t.Fatalf("opaque configure consent: %q", configure)
	}
	delegate := pluginConsentText(pluginRequest{Operation: "invoke", PluginID: "fleet.acp", Action: "delegate", Input: json.RawMessage(`{"cwd":"/work/project","prompt":"fix the tests"}`)})
	if !strings.Contains(delegate, "/work/project") || !strings.Contains(delegate, "fix the tests") {
		t.Fatalf("opaque delegate consent: %q", delegate)
	}
}

func TestPluginConsentExplainsTransferEndpoints(t *testing.T) {
	source := pluginConsentText(pluginRequest{
		Operation: "invoke", PluginID: "fleet.transfer", Action: "prepare_source",
		Input: json.RawMessage(`{"path":"/Users/me/report.pdf","peer":"office-mini"}`),
	})
	if !strings.Contains(source, "/Users/me/report.pdf") || !strings.Contains(source, "office-mini") {
		t.Fatalf("opaque source consent: %q", source)
	}
	target := pluginConsentText(pluginRequest{
		Operation: "invoke", PluginID: "fleet.transfer", Action: "prepare_target",
		Input: json.RawMessage(`{"directory":"/srv/incoming","name":"report.pdf","size":1048576,"peer":"macbook","overwrite":false}`),
	})
	for _, want := range []string{filepath.Join("/srv/incoming", "report.pdf"), "1048576", "macbook", "will not overwrite"} {
		if !strings.Contains(target, want) {
			t.Fatalf("target consent missing %q: %q", want, target)
		}
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
	t.Setenv(pluginStreamHelperEnv, "1")
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

func TestPluginStreamDoesNotCapFileBytes(t *testing.T) {
	installPluginTestBinary(t)
	stream, err := startPluginStream(context.Background(), "fleet.transfer", "prepare_source", json.RawMessage(`{"path":"/tmp/a"}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := stream.Stdin().Close(); err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		OK   bool  `json:"ok"`
		Size int64 `json:"size"`
	}
	if err := stream.ReadJSONLine(&manifest); err != nil {
		t.Fatal(err)
	}
	n, err := io.Copy(io.Discard, stream.Stdout())
	if err != nil {
		t.Fatal(err)
	}
	if err := stream.Wait(); err != nil {
		t.Fatal(err)
	}
	if !manifest.OK || manifest.Size != 3<<20 || n != 3<<20 {
		t.Fatalf("manifest=%+v bytes=%d", manifest, n)
	}
}

func TestPluginStreamTargetKeepsPayloadOutOfJSON(t *testing.T) {
	installPluginTestBinary(t)
	stream, err := startPluginStream(context.Background(), "fleet.transfer", "prepare_target", json.RawMessage(`{"path":"/tmp/b"}`))
	if err != nil {
		t.Fatal(err)
	}
	payload := bytes.Repeat([]byte("payload"), 20000)
	if _, err := stream.Stdin().Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := stream.Stdin().Close(); err != nil {
		t.Fatal(err)
	}
	var committed struct {
		Committed int64 `json:"committed"`
	}
	if err := stream.ReadJSONLine(&committed); err != nil {
		t.Fatal(err)
	}
	var done struct {
		Done bool `json:"done"`
	}
	if err := stream.ReadJSONLine(&done); err != nil {
		t.Fatal(err)
	}
	if err := stream.Wait(); err != nil {
		t.Fatal(err)
	}
	if committed.Committed != int64(len(payload)) || !done.Done {
		t.Fatalf("committed=%d done=%v", committed.Committed, done.Done)
	}
}

func TestPluginStreamBoundsControlAndHonorsCancellation(t *testing.T) {
	installPluginTestBinary(t)
	tooLarge, err := json.Marshal(map[string]string{"value": strings.Repeat("x", pluginStreamLine)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := startPluginStream(context.Background(), "fleet.transfer", "prepare_source", tooLarge); err == nil {
		t.Fatal("oversized control line accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	stream, err := startPluginStream(ctx, "fleet.transfer", "hang", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := stream.Wait(); err == nil || !strings.Contains(err.Error(), "canceled") {
		t.Fatalf("cancel error=%v", err)
	}
}
