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
)

type pluginArtifact struct {
	OS         string `json:"os"`
	Arch       string `json:"arch"`
	URL        string `json:"url"`
	SHA256     string `json:"sha256"`
	Entrypoint string `json:"entrypoint"`
}

type pluginManifest struct {
	SchemaVersion int              `json:"schema_version"`
	ID            string           `json:"id"`
	Name          string           `json:"name"`
	Version       string           `json:"version"`
	Publisher     string           `json:"publisher"`
	License       string           `json:"license"`
	Repository    string           `json:"repository"`
	Artifacts     []pluginArtifact `json:"artifacts"`
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
	ID          string `json:"id"`
	Name        string `json:"name"`
	Version     string `json:"version"`
	Publisher   string `json:"publisher"`
	License     string `json:"license"`
	Repository  string `json:"repository"`
	SHA256      string `json:"sha256"`
	Entrypoint  string `json:"entrypoint"`
	InstalledAt int64  `json:"installed_at"`
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
		}
		_ = json.Unmarshal(req.Input, &input)
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
	a.mu.Lock()
	v, msg := a.inputVerdict()
	// Software changes always require a person at the device, even under permit=allow.
	if pluginSoftwareChange(req.Operation) && v == permitProceed {
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
			result, err = installPlugin(ctx, *req.Manifest)
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
	if strings.TrimSpace(m.Version) == "" {
		return pluginArtifact{}, errors.New("plugin version required")
	}
	repo, err := url.Parse(m.Repository)
	if err != nil || repo.Scheme != "https" || repo.Host != "github.com" || !strings.HasPrefix(repo.Path, "/TITOCHAN2023/") {
		return pluginArtifact{}, errors.New("untrusted plugin repository")
	}
	for _, artifact := range m.Artifacts {
		if artifact.OS != runtime.GOOS || artifact.Arch != runtime.GOARCH {
			continue
		}
		u, err := url.Parse(artifact.URL)
		if err != nil || u.Scheme != "https" || u.Host != "github.com" || !strings.HasPrefix(u.Path, "/TITOCHAN2023/") || !strings.Contains(u.Path, "/releases/download/") {
			return pluginArtifact{}, errors.New("untrusted plugin artifact URL")
		}
		if len(artifact.SHA256) != 64 {
			return pluginArtifact{}, errors.New("invalid plugin SHA-256")
		}
		if _, err := hex.DecodeString(artifact.SHA256); err != nil {
			return pluginArtifact{}, errors.New("invalid plugin SHA-256")
		}
		if filepath.Base(artifact.Entrypoint) != artifact.Entrypoint || artifact.Entrypoint == "." {
			return pluginArtifact{}, errors.New("invalid plugin entrypoint")
		}
		return artifact, nil
	}
	return pluginArtifact{}, fmt.Errorf("plugin has no artifact for %s/%s", runtime.GOOS, runtime.GOARCH)
}

func installPlugin(ctx context.Context, m pluginManifest) (installedPlugin, error) {
	artifact, err := validateOfficialManifest(m)
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
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, artifact.URL, nil)
	if err != nil {
		return installedPlugin{}, err
	}
	req.Header.Set("User-Agent", "Fleet-Agent/"+agentVersion)
	client := &http.Client{Timeout: 3 * time.Minute}
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
	meta := installedPlugin{ID: m.ID, Name: m.Name, Version: m.Version, Publisher: m.Publisher, License: m.License, Repository: m.Repository, SHA256: strings.ToLower(artifact.SHA256), Entrypoint: artifact.Entrypoint, InstalledAt: time.Now().UnixMilli()}
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
	return meta, dir, nil
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
	meta, dir, err := readPluginMeta(req.PluginID)
	if err != nil {
		return nil, fmt.Errorf("plugin %s is not installed", req.PluginID)
	}
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
	cmd := exec.CommandContext(callCtx, filepath.Join(dir, meta.Entrypoint))
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
