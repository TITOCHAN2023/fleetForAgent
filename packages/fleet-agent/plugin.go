package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	pendingKindPlugin = "plugin"
	pluginMaxDownload = 100 << 20
	pluginMaxOutput   = 2 << 20
	pluginStreamLine  = 64 << 10
)

type pluginArtifact struct {
	OS         string `json:"os"`
	Arch       string `json:"arch"`
	URL        string `json:"url"`
	MirrorURL  string `json:"mirror_url,omitempty"`
	SHA256     string `json:"sha256"`
	Entrypoint string `json:"entrypoint"`
}

type pluginManifest struct {
	SchemaVersion   int              `json:"schema_version"`
	ID              string           `json:"id"`
	Name            string           `json:"name"`
	Version         string           `json:"version"`
	Publisher       string           `json:"publisher"`
	License         string           `json:"license"`
	Repository      string           `json:"repository"`
	Actions         []string         `json:"actions"`
	ApprovalActions []string         `json:"approval_actions,omitempty"`
	Artifacts       []pluginArtifact `json:"artifacts"`
}

type pluginRequest struct {
	Operation string          `json:"operation"`
	PluginID  string          `json:"plugin_id,omitempty"`
	Manifest  *pluginManifest `json:"manifest,omitempty"`
	Action    string          `json:"action,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	TimeoutS  int             `json:"timeout_seconds,omitempty"`
}

type installedPlugin struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Version         string   `json:"version"`
	Publisher       string   `json:"publisher"`
	License         string   `json:"license"`
	Repository      string   `json:"repository"`
	ArtifactURL     string   `json:"artifact_url,omitempty"`
	SHA256          string   `json:"sha256"`
	Entrypoint      string   `json:"entrypoint"`
	Actions         []string `json:"actions,omitempty"`
	ApprovalActions []string `json:"approval_actions,omitempty"`
	InstalledAt     int64    `json:"installed_at"`
}

type capBuffer struct {
	b   bytes.Buffer
	max int
}

func (b *capBuffer) Write(p []byte) (int, error) {
	want := len(p)
	if b.b.Len() < b.max {
		left := b.max - b.b.Len()
		if len(p) > left {
			p = p[:left]
		}
		_, _ = b.b.Write(p)
	}
	return want, nil
}

func (b *capBuffer) String() string { return b.b.String() }

func decodePluginRequest(body map[string]any) (pluginRequest, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return pluginRequest{}, err
	}
	var req pluginRequest
	if err := json.Unmarshal(b, &req); err != nil {
		return req, err
	}
	req.Operation = strings.TrimSpace(req.Operation)
	req.PluginID = strings.TrimSpace(req.PluginID)
	req.Action = strings.TrimSpace(req.Action)
	return req, nil
}

func pluginConsentText(req pluginRequest) string {
	switch req.Operation {
	case "install":
		if req.Manifest != nil {
			return fmt.Sprintf("install plugin %s %s", req.Manifest.Name, req.Manifest.Version)
		}
		return "install plugin " + req.PluginID
	case "uninstall":
		return "uninstall plugin " + req.PluginID
	case "invoke":
		var input struct {
			Command        string `json:"command"`
			CWD            string `json:"cwd"`
			Prompt         string `json:"prompt"`
			PermissionMode string `json:"permission_mode"`
			Path           string `json:"path"`
			Directory      string `json:"directory"`
			Name           string `json:"name"`
			Peer           string `json:"peer"`
			Size           int64  `json:"size"`
		}
		_ = json.Unmarshal(req.Input, &input)
		if req.PluginID == "fleet.transfer" && req.Action == "prepare_source" {
			return fmt.Sprintf("send file %q to %q", input.Path, input.Peer)
		}
		if req.PluginID == "fleet.transfer" && req.Action == "prepare_target" {
			target := filepath.Join(input.Directory, input.Name)
			return fmt.Sprintf("receive %d bytes from %q into %q (will not overwrite)", input.Size, input.Peer, target)
		}
		if req.Action == "configure" && strings.TrimSpace(input.Command) != "" {
			return fmt.Sprintf("plugin %s configure command: %s", req.PluginID, clip(input.Command, 80))
		}
		if req.Action == "delegate" {
			nested := "nested permissions rejected"
			if input.PermissionMode == "allow_once" {
				nested = "nested permissions allow once"
			}
			return fmt.Sprintf("plugin %s delegate in %s (%s): %s", req.PluginID, clip(input.CWD, 60), nested, clip(input.Prompt, 100))
		}
		return fmt.Sprintf("plugin %s: %s", req.PluginID, req.Action)
	default:
		return "plugin " + req.Operation
	}
}

func pluginSoftwareChange(operation string) bool {
	return operation == "install" || operation == "uninstall"
}

func pluginActionRequiresApproval(id, action string) (bool, error) {
	meta, _, err := installedPluginForAction(id, action)
	if err != nil {
		return false, err
	}
	return containsString(meta.ApprovalActions, action), nil
}

func pluginAcceptedEnv(corr, status string) Envelope {
	return Envelope{V: 1, Type: "plugin_accepted", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: corr, T: time.Now().UnixMilli(), Body: map[string]any{"status": status}}
}

func pluginResultEnv(corr string, result any, err error) Envelope {
	body := map[string]any{"ok": err == nil, "status": "done"}
	if result != nil {
		body["result"] = result
	}
	if err != nil {
		body["error"] = err.Error()
	}
	return Envelope{V: 1, Type: "plugin_result", ID: fmt.Sprintf("%d", time.Now().UnixNano()), Corr: corr, T: time.Now().UnixMilli(), Body: body}
}

func (a *Agent) handlePlugin(ctx context.Context, sink EnvelopeSink, env Envelope) {
	req, err := decodePluginRequest(env.Body)
	if err != nil {
		_ = sink(ctx, pluginResultEnv(env.Corr, nil, fmt.Errorf("invalid plugin request: %w", err)))
		return
	}
	if req.Operation == "list" {
		_ = sink(ctx, pluginAcceptedEnv(env.Corr, "running"))
		go a.executePlugin(context.Background(), sink, env.Corr, req)
		return
	}
	alwaysAsk := pluginSoftwareChange(req.Operation)
	if req.Operation == "invoke" {
		alwaysAsk, err = pluginActionRequiresApproval(req.PluginID, req.Action)
		if err != nil {
			_ = sink(ctx, pluginResultEnv(env.Corr, nil, err))
			return
		}
	}
	a.mu.Lock()
	v, msg := a.inputVerdict()
	// Software changes and manifest-declared sensitive actions always require a
	// person at the device, even under permit=allow.
	if alwaysAsk && v == permitProceed {
		if a.pending != nil {
			v, msg = permitRefuse, "fleet: another command is waiting for consent"
		} else {
			v = permitAsk
		}
	}
	if v == permitRefuse {
		a.mu.Unlock()
		_ = sink(ctx, pluginResultEnv(env.Corr, nil, errors.New(msg)))
		return
	}
	if v == permitAsk {
		label := pluginConsentText(req)
		a.pending = &Pending{Kind: pendingKindPlugin, Corr: env.Corr, Command: label, Requested: time.Now().UnixMilli(), Plugin: &req, Sink: sink}
		a.log("warn", "waiting consent: "+label)
		a.mu.Unlock()
		_ = sink(ctx, pluginAcceptedEnv(env.Corr, "waiting_approval"))
		notifyConsent(label)
		a.pushUI()
		return
	}
	a.mu.Unlock()
	_ = sink(ctx, pluginAcceptedEnv(env.Corr, "running"))
	go a.executePlugin(context.Background(), sink, env.Corr, req)
}

func (a *Agent) executePlugin(ctx context.Context, sink EnvelopeSink, corr string, req pluginRequest) {
	var result any
	var err error
	switch req.Operation {
	case "list":
		result, err = listInstalledPlugins()
	case "install":
		if req.Manifest == nil {
			err = errors.New("manifest required")
		} else {
			a.mu.Lock()
			hubInput, hubToken := a.hubInput, a.hubToken
			a.mu.Unlock()
			result, err = installPluginFromHub(ctx, *req.Manifest, hubInput, hubToken)
		}
	case "uninstall":
		result, err = uninstallPlugin(req.PluginID)
	case "invoke":
		result, err = invokePlugin(ctx, req)
	default:
		err = fmt.Errorf("unknown plugin operation %q", req.Operation)
	}
	_ = sink(ctx, pluginResultEnv(corr, result, err))
	a.mu.Lock()
	if err != nil {
		a.log("error", "plugin "+req.Operation+": "+err.Error())
	} else {
		a.log("info", "plugin "+req.Operation+" completed")
	}
	a.mu.Unlock()
	if req.Operation == "install" || req.Operation == "uninstall" {
		if relay := a.relayEnvelopeSink(); relay != nil {
			_ = relay(context.Background(), Envelope{
				V: 1, Type: "ping", ID: fmt.Sprintf("%d", time.Now().UnixNano()), T: time.Now().UnixMilli(),
				Body: map[string]any{"agent_ver": agentVersion, "caps": agentCaps()},
			})
		}
	}
	a.pushUI()
}

func pluginsDir() string { return filepath.Join(fleetHome(), "plugins") }

func cleanPluginID(id string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" || len(id) > 80 {
		return "", errors.New("invalid plugin id")
	}
	for _, r := range id {
		if !(r == '.' || r == '-' || r == '_' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9') {
			return "", errors.New("invalid plugin id")
		}
	}
	return id, nil
}

func cleanPluginAction(action string) (string, error) {
	action = strings.TrimSpace(action)
	if action == "" || len(action) > 80 {
		return "", errors.New("invalid plugin action")
	}
	for _, r := range action {
		if !(r == '.' || r == '-' || r == '_' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9') {
			return "", errors.New("invalid plugin action")
		}
	}
	return action, nil
}

func cleanPluginVersion(version string) (string, error) {
	version = strings.TrimSpace(version)
	if version == "" || len(version) > 80 {
		return "", errors.New("invalid plugin version")
	}
	for _, r := range version {
		if !(r == '.' || r == '-' || r == '_' || r == '+' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return "", errors.New("invalid plugin version")
		}
	}
	return version, nil
}

func cleanPluginEntrypoint(entrypoint string) (string, error) {
	if entrypoint == "" || entrypoint == "." || entrypoint == ".." || strings.ContainsAny(entrypoint, `/\\`) {
		return "", errors.New("invalid plugin entrypoint")
	}
	return entrypoint, nil
}

func officialRepositoryPath(raw string) (string, error) {
	repo, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || repo.Scheme != "https" || repo.Host != "github.com" || repo.User != nil || repo.RawQuery != "" || repo.Fragment != "" {
		return "", errors.New("untrusted plugin repository")
	}
	path := strings.TrimSuffix(repo.Path, "/")
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(parts) != 2 || parts[0] != "TITOCHAN2023" {
		return "", errors.New("untrusted plugin repository")
	}
	if _, err := cleanPluginID(parts[1]); err != nil {
		return "", errors.New("untrusted plugin repository")
	}
	return path, nil
}

func validateArtifactURL(raw, repository, version string) error {
	repoPath, err := officialRepositoryPath(repository)
	if err != nil {
		return err
	}
	version, err = cleanPluginVersion(version)
	if err != nil {
		return err
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || u.Host != "github.com" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("untrusted plugin artifact URL")
	}
	prefix := repoPath + "/releases/download/v" + version + "/"
	name := strings.TrimPrefix(u.Path, prefix)
	if name == u.Path || name == "" || strings.Contains(name, "/") {
		return errors.New("plugin artifact does not match repository and version")
	}
	return nil
}

func validatePluginMirrorURL(raw, pluginID, version, osName, arch, hubInput string) error {
	pluginID, err := cleanPluginID(pluginID)
	if err != nil {
		return err
	}
	version, err = cleanPluginVersion(version)
	if err != nil {
		return err
	}
	expectedOrigin := hubOrigin(hubInput)
	if expectedOrigin == "" {
		return errors.New("plugin mirror requires the configured hub origin")
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" ||
		hubOrigin(u.Scheme+"://"+u.Host) != expectedOrigin {
		return errors.New("plugin mirror must use the configured hub origin")
	}
	expectedPath := "/v1/plugin-artifact/" + pluginID + "/" + version + "/" + osName + "/" + arch
	if u.Path != expectedPath {
		return errors.New("invalid plugin mirror path")
	}
	return nil
}

func cleanStringSet(values []string, required bool) ([]string, error) {
	if required && len(values) == 0 {
		return nil, errors.New("plugin actions required")
	}
	if len(values) > 64 {
		return nil, errors.New("too many plugin actions")
	}
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value, err := cleanPluginAction(value)
		if err != nil {
			return nil, err
		}
		if _, ok := seen[value]; ok {
			return nil, fmt.Errorf("duplicate plugin action %q", value)
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out, nil
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func pluginActions(id string, actions, approvalActions []string) ([]string, []string, error) {
	// fleet.acp predates persisted action metadata. Preserve those installations
	// with its fixed historical surface instead of turning an absent allowlist
	// into an allow-all bypass.
	if len(actions) == 0 && id == "fleet.acp" {
		actions = []string{"configure", "profiles", "delegate"}
	}
	actions, err := cleanStringSet(actions, true)
	if err != nil {
		return nil, nil, err
	}
	approvalActions, err = cleanStringSet(approvalActions, false)
	if err != nil {
		return nil, nil, err
	}
	for _, action := range approvalActions {
		if !containsString(actions, action) {
			return nil, nil, fmt.Errorf("approval action %q is not declared", action)
		}
	}
	return actions, approvalActions, nil
}

func pluginDir(id string) (string, error) {
	id, err := cleanPluginID(id)
	if err != nil {
		return "", err
	}
	return filepath.Join(pluginsDir(), id), nil
}

func validateOfficialManifest(m pluginManifest) (pluginArtifact, error) {
	if m.SchemaVersion != 1 || m.Publisher != "Fleet Official" || m.License == "" {
		return pluginArtifact{}, errors.New("untrusted plugin manifest")
	}
	if _, err := cleanPluginID(m.ID); err != nil {
		return pluginArtifact{}, err
	}
	if _, err := cleanPluginVersion(m.Version); err != nil {
		return pluginArtifact{}, err
	}
	if _, err := officialRepositoryPath(m.Repository); err != nil {
		return pluginArtifact{}, err
	}
	if _, _, err := pluginActions(m.ID, m.Actions, m.ApprovalActions); err != nil {
		return pluginArtifact{}, err
	}
	for _, artifact := range m.Artifacts {
		if artifact.OS != runtime.GOOS || artifact.Arch != runtime.GOARCH {
			continue
		}
		if err := validateArtifactURL(artifact.URL, m.Repository, m.Version); err != nil {
			return pluginArtifact{}, err
		}
		if len(artifact.SHA256) != 64 {
			return pluginArtifact{}, errors.New("invalid plugin SHA-256")
		}
		if _, err := hex.DecodeString(artifact.SHA256); err != nil {
			return pluginArtifact{}, errors.New("invalid plugin SHA-256")
		}
		if _, err := cleanPluginEntrypoint(artifact.Entrypoint); err != nil {
			return pluginArtifact{}, err
		}
		return artifact, nil
	}
	return pluginArtifact{}, fmt.Errorf("plugin has no artifact for %s/%s", runtime.GOOS, runtime.GOARCH)
}

func installPlugin(ctx context.Context, m pluginManifest) (installedPlugin, error) {
	return installPluginFromHub(ctx, m, "", "")
}

func installPluginFromHub(ctx context.Context, m pluginManifest, hubInput, hubToken string) (installedPlugin, error) {
	artifact, err := validateOfficialManifest(m)
	if err != nil {
		return installedPlugin{}, err
	}
	actions, approvalActions, err := pluginActions(m.ID, m.Actions, m.ApprovalActions)
	if err != nil {
		return installedPlugin{}, err
	}
	dir, err := pluginDir(m.ID)
	if err != nil {
		return installedPlugin{}, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return installedPlugin{}, err
	}
	downloadURL := artifact.URL
	authorization := ""
	if strings.TrimSpace(artifact.MirrorURL) != "" {
		if err := validatePluginMirrorURL(artifact.MirrorURL, m.ID, m.Version, artifact.OS, artifact.Arch, hubInput); err != nil {
			return installedPlugin{}, err
		}
		downloadURL = artifact.MirrorURL
		authorization, err = highSecAuthorization(ctx, hubInput, hubToken)
		if err != nil {
			return installedPlugin{}, err
		}
		if authorization == "" {
			return installedPlugin{}, errors.New("plugin mirror requires Hub authentication")
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return installedPlugin{}, err
	}
	req.Header.Set("User-Agent", "Fleet-Agent/"+agentVersion)
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	client := &http.Client{Timeout: 3 * time.Minute}
	if strings.TrimSpace(artifact.MirrorURL) != "" {
		client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		}
	}
	res, err := client.Do(req)
	if err != nil {
		return installedPlugin{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return installedPlugin{}, fmt.Errorf("download plugin: HTTP %d", res.StatusCode)
	}
	if res.ContentLength > pluginMaxDownload {
		return installedPlugin{}, errors.New("plugin artifact exceeds 100 MiB")
	}
	tmp, err := os.CreateTemp(dir, ".download-*")
	if err != nil {
		return installedPlugin{}, err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	h := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(res.Body, pluginMaxDownload+1))
	closeErr := tmp.Close()
	if copyErr != nil {
		return installedPlugin{}, copyErr
	}
	if closeErr != nil {
		return installedPlugin{}, closeErr
	}
	if n > pluginMaxDownload {
		return installedPlugin{}, errors.New("plugin artifact exceeds 100 MiB")
	}
	got := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(got, artifact.SHA256) {
		return installedPlugin{}, fmt.Errorf("plugin SHA-256 mismatch: got %s", got)
	}
	if err := os.Chmod(tmpName, 0o700); err != nil {
		return installedPlugin{}, err
	}
	target := filepath.Join(dir, artifact.Entrypoint)
	backup := target + ".previous"
	_ = os.Remove(backup)
	if _, err := os.Stat(target); err == nil {
		if err := os.Rename(target, backup); err != nil {
			return installedPlugin{}, err
		}
	}
	if err := os.Rename(tmpName, target); err != nil {
		_ = os.Rename(backup, target)
		return installedPlugin{}, err
	}
	meta := installedPlugin{
		ID:              m.ID,
		Name:            m.Name,
		Version:         m.Version,
		Publisher:       m.Publisher,
		License:         m.License,
		Repository:      m.Repository,
		ArtifactURL:     artifact.URL,
		SHA256:          strings.ToLower(artifact.SHA256),
		Entrypoint:      artifact.Entrypoint,
		Actions:         actions,
		ApprovalActions: approvalActions,
		InstalledAt:     time.Now().UnixMilli(),
	}
	if err := writePluginMeta(dir, meta); err != nil {
		_ = os.Remove(target)
		_ = os.Rename(backup, target)
		return installedPlugin{}, err
	}
	_ = os.Remove(backup)
	return meta, nil
}

func writePluginMeta(dir string, meta installedPlugin) error {
	b, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, ".metadata.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	target := filepath.Join(dir, "metadata.json")
	if runtime.GOOS == "windows" {
		_ = os.Remove(target)
	}
	return os.Rename(tmp, target)
}

func readPluginMeta(id string) (installedPlugin, string, error) {
	dir, err := pluginDir(id)
	if err != nil {
		return installedPlugin{}, "", err
	}
	b, err := os.ReadFile(filepath.Join(dir, "metadata.json"))
	if err != nil {
		return installedPlugin{}, "", err
	}
	var meta installedPlugin
	if err := json.Unmarshal(b, &meta); err != nil {
		return meta, "", err
	}
	if meta.ID != id {
		return meta, "", errors.New("plugin metadata id mismatch")
	}
	actions, approvalActions, err := pluginActions(meta.ID, meta.Actions, meta.ApprovalActions)
	if err != nil {
		return meta, "", err
	}
	meta.Actions = actions
	meta.ApprovalActions = approvalActions
	return meta, dir, nil
}

// installedPluginMetadata returns a detached, read-only view for core handlers.
// In particular, callers can decide consent policy without parsing metadata.json.
func installedPluginMetadata(id string) (installedPlugin, error) {
	meta, _, err := readPluginMeta(id)
	if err != nil {
		return installedPlugin{}, err
	}
	meta.Actions = append([]string(nil), meta.Actions...)
	meta.ApprovalActions = append([]string(nil), meta.ApprovalActions...)
	return meta, nil
}

func validateInstalledPlugin(meta installedPlugin) error {
	if _, err := cleanPluginID(meta.ID); err != nil {
		return err
	}
	if meta.Publisher != "Fleet Official" || strings.TrimSpace(meta.License) == "" {
		return errors.New("untrusted installed plugin")
	}
	if _, err := cleanPluginVersion(meta.Version); err != nil {
		return err
	}
	if _, err := officialRepositoryPath(meta.Repository); err != nil {
		return err
	}
	if meta.ArtifactURL == "" {
		if meta.ID != "fleet.acp" {
			return errors.New("installed plugin is missing artifact provenance; reinstall it")
		}
	} else if err := validateArtifactURL(meta.ArtifactURL, meta.Repository, meta.Version); err != nil {
		return err
	}
	if len(meta.SHA256) != 64 {
		return errors.New("invalid installed plugin SHA-256")
	}
	if _, err := hex.DecodeString(meta.SHA256); err != nil {
		return errors.New("invalid installed plugin SHA-256")
	}
	if _, err := cleanPluginEntrypoint(meta.Entrypoint); err != nil {
		return err
	}
	_, _, err := pluginActions(meta.ID, meta.Actions, meta.ApprovalActions)
	return err
}

func verifyPluginBinary(dir string, meta installedPlugin) (string, error) {
	path := filepath.Join(dir, meta.Entrypoint)
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("plugin entrypoint is not a regular file")
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	got := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(got, meta.SHA256) {
		return "", fmt.Errorf("installed plugin SHA-256 mismatch: got %s", got)
	}
	return path, nil
}

func trustedInstalledPlugin(id string) (installedPlugin, string, string, error) {
	meta, dir, err := readPluginMeta(id)
	if err != nil {
		return installedPlugin{}, "", "", err
	}
	if err := validateInstalledPlugin(meta); err != nil {
		return installedPlugin{}, "", "", err
	}
	path, err := verifyPluginBinary(dir, meta)
	if err != nil {
		return installedPlugin{}, "", "", err
	}
	return meta, dir, path, nil
}

func installedPluginForAction(id, action string) (installedPlugin, string, error) {
	action, err := cleanPluginAction(action)
	if err != nil {
		return installedPlugin{}, "", err
	}
	meta, _, path, err := trustedInstalledPlugin(id)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return installedPlugin{}, "", fmt.Errorf("plugin %s is not installed", id)
		}
		return installedPlugin{}, "", err
	}
	if !containsString(meta.Actions, action) {
		return installedPlugin{}, "", fmt.Errorf("plugin %s does not declare action %q", id, action)
	}
	return meta, path, nil
}

func listInstalledPlugins() ([]installedPlugin, error) {
	entries, err := os.ReadDir(pluginsDir())
	if errors.Is(err, os.ErrNotExist) {
		return []installedPlugin{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := make([]installedPlugin, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		meta, _, err := readPluginMeta(entry.Name())
		if err == nil {
			out = append(out, meta)
		}
	}
	return out, nil
}

func uninstallPlugin(id string) (map[string]any, error) {
	dir, err := pluginDir(id)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(filepath.Join(dir, "metadata.json")); err != nil {
		return nil, fmt.Errorf("plugin %s is not installed", id)
	}
	if err := os.RemoveAll(dir); err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "removed": true}, nil
}

func invokePlugin(ctx context.Context, req pluginRequest) (any, error) {
	_, path, err := installedPluginForAction(req.PluginID, req.Action)
	if err != nil {
		return nil, err
	}
	dir := filepath.Dir(path)
	timeout := req.TimeoutS
	if timeout <= 0 {
		timeout = 900
	}
	if timeout > 3600 {
		timeout = 3600
	}
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()
	input := req.Input
	if len(input) == 0 {
		input = json.RawMessage(`{}`)
	}
	payload, err := json.Marshal(map[string]any{"action": req.Action, "input": input})
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(callCtx, path)
	cmd.Env = append(os.Environ(), "FLEET_PLUGIN_DATA_DIR="+filepath.Join(dir, "data"))
	cmd.Stdin = bytes.NewReader(payload)
	out := &capBuffer{max: pluginMaxOutput}
	errOut := &capBuffer{max: 256 << 10}
	cmd.Stdout, cmd.Stderr = out, errOut
	if err := cmd.Run(); err != nil {
		if callCtx.Err() != nil {
			return nil, fmt.Errorf("plugin timed out: %w", callCtx.Err())
		}
		return nil, fmt.Errorf("plugin failed: %w: %s", err, strings.TrimSpace(errOut.String()))
	}
	var reply struct {
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
		Error  string          `json:"error"`
	}
	if err := json.Unmarshal([]byte(out.String()), &reply); err != nil {
		return nil, fmt.Errorf("invalid plugin response: %w", err)
	}
	if !reply.OK {
		return nil, errors.New(reply.Error)
	}
	var result any
	if len(reply.Result) > 0 {
		if err := json.Unmarshal(reply.Result, &result); err != nil {
			return nil, err
		}
	}
	return result, nil
}
