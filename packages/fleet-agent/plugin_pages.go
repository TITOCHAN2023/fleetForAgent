package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/TITOCHAN2023/fleetForAgent/internal/activity"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// UI actions are an optional, backwards-compatible capability of a trusted
// plugin. Assets come from the verified executable, never a separate web host.
type pluginUI struct {
	Title        string   `json:"title"`
	PageAction   string   `json:"page_action"`
	ReadActions  []string `json:"read_actions,omitempty"`
	WriteActions []string `json:"write_actions,omitempty"`
}
type pluginPageSession struct {
	ID, Hash string
	Expires  time.Time
	Results  map[string]map[string]any
	Cancels  map[string]bool
}
type localPluginCallKey struct{}

func validatePluginUI(ui *pluginUI, actions []string, specs map[string]pluginActionSpec, defaultRuntime string) error {
	if ui == nil {
		return nil
	}
	if strings.TrimSpace(ui.Title) == "" || len(ui.Title) > 80 {
		return errors.New("invalid plugin UI title")
	}
	seen := map[string]bool{}
	for _, action := range append(append([]string{ui.PageAction}, ui.ReadActions...), ui.WriteActions...) {
		if seen[action] {
			return errors.New("duplicate plugin UI action")
		}
		seen[action] = true
		if clean, err := cleanPluginAction(action); err != nil || clean != action || !containsString(actions, action) {
			return errors.New("UI action must be declared")
		}
		runtimeName := defaultRuntime
		if spec, ok := specs[action]; ok {
			runtimeName = spec.Runtime
		}
		if runtimeName != "" && runtimeName != pluginRuntimeTask {
			return errors.New("plugin UI requires task actions")
		}
	}
	return nil
}

func (a *Agent) registerPluginPages(mux *http.ServeMux) {
	mux.HandleFunc("/api/plugins", func(w http.ResponseWriter, r *http.Request) {
		rows, err := listInstalledPlugins()
		if err != nil {
			http.Error(w, "plugin inventory unavailable", 500)
			return
		}
		writeJSON(w, map[string]any{"plugins": rows})
	})
	mux.HandleFunc("/api/plugins/open", a.openPluginPage)
	mux.HandleFunc("/api/plugins/invoke", a.invokePluginPage)
	mux.HandleFunc("/api/plugins/result", a.pluginPageResult)
	mux.HandleFunc("/api/plugins/cancel", a.cancelPluginPageTask)
	mux.HandleFunc("/api/plugins/install-local", a.installLocalPlugin)
	mux.HandleFunc("/api/plugins/close", a.closePluginPage)
	mux.HandleFunc("/api/plugins/uninstall-local", a.uninstallLocalPlugin)
}

func decodeLocalRequest(w http.ResponseWriter, r *http.Request, out any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10))
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		http.Error(w, "invalid request", 400)
		return false
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		http.Error(w, "invalid trailing JSON", 400)
		return false
	}
	return true
}

func (a *Agent) openPluginPage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PluginID string `json:"plugin_id"`
	}
	if !decodeLocalRequest(w, r, &body) {
		return
	}
	var html string
	var meta installedPlugin
	_, err := withPluginReadLock(body.PluginID, func() (any, error) {
		m, _, _, err := trustedInstalledPlugin(body.PluginID)
		if err != nil {
			return nil, err
		}
		meta = m
		if m.UI == nil {
			return nil, errors.New("plugin has no page")
		}
		ctx := context.WithValue(r.Context(), pluginInvocationKey{}, pluginInvocation{V: 1, Origin: "local", DeviceID: a.deviceID, Actor: "local", agent: a})
		reply, err := invokePluginTask(ctx, pluginRequest{PluginID: m.ID, Action: m.UI.PageAction, TimeoutS: 5, Local: true, Principal: "local"})
		if err != nil {
			return nil, err
		}
		row, ok := reply.(map[string]any)
		if !ok {
			return nil, errors.New("invalid plugin page response")
		}
		html, ok = row["html"].(string)
		if !ok || len(html) > 256<<10 {
			return nil, errors.New("invalid plugin HTML")
		}
		return nil, nil
	})
	if err != nil {
		http.Error(w, err.Error(), 409)
		return
	}
	token := randomLocalToken()
	if token == "" {
		http.Error(w, "page unavailable", 500)
		return
	}
	a.expirePluginPages()
	a.pageMu.Lock()
	if a.pages == nil {
		a.pages = map[string]pluginPageSession{}
	}
	if len(a.pages) >= 32 {
		a.pageMu.Unlock()
		http.Error(w, "too many pages", 429)
		return
	}
	a.pages[token] = pluginPageSession{ID: meta.ID, Hash: pluginPageDigest(meta), Expires: time.Now().Add(30 * time.Minute), Results: map[string]map[string]any{}, Cancels: map[string]bool{}}
	a.pageMu.Unlock()
	writeJSON(w, map[string]any{"html": html, "page_token": token, "title": meta.UI.Title, "write_actions": meta.UI.WriteActions})
}

func (a *Agent) pageSession(token string) (pluginPageSession, installedPlugin, error) {
	a.pageMu.Lock()
	page, ok := a.pages[token]
	a.pageMu.Unlock()
	if !ok || time.Now().After(page.Expires) {
		a.invalidatePluginPage(token)
		return page, installedPlugin{}, errors.New("plugin page expired")
	}
	meta, _, _, err := trustedInstalledPlugin(page.ID)
	if err != nil || pluginPageDigest(meta) != page.Hash || meta.UI == nil {
		a.invalidatePluginPage(token)
		return page, meta, errors.New("plugin changed; reopen its page")
	}
	return page, meta, nil
}

func (a *Agent) invokePluginPage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token  string          `json:"page_token"`
		Action string          `json:"action"`
		Input  json.RawMessage `json:"input"`
	}
	if !decodeLocalRequest(w, r, &body) {
		return
	}
	page, meta, err := a.pageSession(body.Token)
	if err != nil {
		http.Error(w, err.Error(), 403)
		return
	}
	read := containsString(meta.UI.ReadActions, body.Action)
	if !read && !containsString(meta.UI.WriteActions, body.Action) {
		http.Error(w, "action is not exposed to this page", 403)
		return
	}
	corr := "local-" + randomLocalToken()
	if corr == "local-" {
		http.Error(w, "request unavailable", 500)
		return
	}
	a.pageMu.Lock()
	p := a.pages[body.Token]
	if len(p.Results) >= 128 {
		a.pageMu.Unlock()
		http.Error(w, "page request limit; reopen", 429)
		return
	}
	p.Results[corr] = map[string]any{"status": "pending"}
	a.pages[body.Token] = p
	a.pageMu.Unlock()
	sink := a.activitySink(func(_ context.Context, e Envelope) error {
		a.pageMu.Lock()
		defer a.pageMu.Unlock()
		p, ok := a.pages[body.Token]
		if !ok {
			return nil
		}
		p.Results[corr] = e.Body
		a.pages[body.Token] = p
		return nil
	})
	req := pluginRequest{Operation: "invoke", PluginID: page.ID, Action: body.Action, Input: body.Input, Local: true}
	if read {
		a.activityRequestAs(context.WithValue(context.Background(), localPluginCallKey{}, true), Envelope{Type: "plugin", Corr: corr, Body: map[string]any{"plugin_id": page.ID, "action": body.Action}})
		req.UIRead = true
		go a.executePlugin(context.Background(), sink, corr, req)
	} else {
		encoded, _ := json.Marshal(req)
		var payload map[string]any
		_ = json.Unmarshal(encoded, &payload)
		ctx := context.WithValue(r.Context(), localPluginCallKey{}, true)
		a.activityRequestAs(ctx, Envelope{Type: "plugin", Corr: corr, Body: payload})
		a.handlePlugin(ctx, sink, Envelope{Type: "plugin", Corr: corr, Body: payload})
	}
	writeJSON(w, map[string]any{"corr": corr, "status": "pending"})
}

func (a *Agent) pluginPageResult(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("page_token")
	page, _, err := a.pageSession(token)
	if err != nil {
		http.Error(w, err.Error(), 403)
		return
	}
	a.pageMu.Lock()
	result, ok := a.pages[token].Results[r.URL.Query().Get("corr")]
	a.pageMu.Unlock()
	if !ok {
		a.taskMu.Lock()
		ledger := a.invocationReceipts
		a.taskMu.Unlock()
		if ledger != nil {
			claim, err := ledger.Lookup(r.URL.Query().Get("corr"))
			var env Envelope
			if err == nil && len(claim.Reply) > 0 && json.Unmarshal(claim.Reply, &env) == nil && page.ID != "" && stringBody(env.Body, "plugin_id") == page.ID {
				result = env.Body
				ok = true
			}
		}
		if !ok {
			http.NotFound(w, r)
			return
		}
	}
	writeJSON(w, result)
}
func (a *Agent) cancelPluginPageTask(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token string `json:"page_token"`
		Corr  string `json:"corr"`
	}
	if !decodeLocalRequest(w, r, &body) {
		return
	}
	page, _, err := a.pageSession(body.Token)
	if err != nil {
		http.Error(w, err.Error(), 403)
		return
	}
	a.pageMu.Lock()
	_, ok := page.Results[body.Corr]
	a.pageMu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	a.cancelLocalPluginTask(body.Corr)
	writeJSON(w, map[string]any{"ok": true})
}

// Local installation is an explicit device-owner operation. Remote plugin
// installation remains restricted to the official registry and release URLs.
func (a *Agent) installLocalPlugin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Directory string `json:"directory"`
	}
	if !decodeLocalRequest(w, r, &body) {
		return
	}
	if !filepath.IsAbs(body.Directory) {
		http.Error(w, "absolute package directory required", 400)
		return
	}
	meta, err := installLocalPackage(body.Directory)
	if err != nil {
		http.Error(w, err.Error(), 409)
		return
	}
	a.recordPluginInstall(meta.ID)
	writeJSON(w, map[string]any{"ok": true, "plugin": meta})
}

func installLocalPackage(directory string) (installedPlugin, error) {
	b, err := os.ReadFile(filepath.Join(directory, "manifest.json"))
	if err != nil {
		return installedPlugin{}, err
	}
	if len(b) > 64<<10 {
		return installedPlugin{}, errors.New("manifest too large")
	}
	var m pluginManifest
	if json.Unmarshal(b, &m) != nil {
		return installedPlugin{}, errors.New("invalid manifest")
	}
	artifact, err := validateOfficialManifest(m)
	if err != nil {
		return installedPlugin{}, err
	}
	var result installedPlugin
	_, err = withPluginWriteLock(m.ID, func() (any, error) {
		source := filepath.Join(directory, artifact.Entrypoint)
		info, err := os.Lstat(source)
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() || info.Size() > pluginMaxDownload {
			return nil, errors.New("invalid local executable")
		}
		f, err := os.Open(source)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		dir, err := pluginDir(m.ID)
		if err != nil {
			return nil, err
		}
		if err = os.MkdirAll(dir, 0700); err != nil {
			return nil, err
		}
		tmp, err := os.CreateTemp(dir, ".local-*")
		if err != nil {
			return nil, err
		}
		defer os.Remove(tmp.Name())
		h := sha256.New()
		_, err = io.Copy(io.MultiWriter(tmp, h), io.LimitReader(f, pluginMaxDownload+1))
		closeErr := tmp.Close()
		if err != nil {
			return nil, err
		}
		if closeErr != nil {
			return nil, closeErr
		}
		if hex.EncodeToString(h.Sum(nil)) != artifact.SHA256 {
			return nil, errors.New("local executable checksum mismatch")
		}
		if err = os.Chmod(tmp.Name(), 0700); err != nil {
			return nil, err
		}
		target := filepath.Join(dir, artifact.Entrypoint)
		backup := target + ".previous"
		_ = os.Remove(backup)
		hadOld := false
		if _, e := os.Lstat(target); e == nil {
			if e = os.Rename(target, backup); e != nil {
				return nil, e
			}
			hadOld = true
		}
		if err = os.Rename(tmp.Name(), target); err != nil {
			if hadOld {
				_ = os.Rename(backup, target)
			}
			return nil, err
		}
		result = installedPlugin{InstallSource: "local", ID: m.ID, Name: m.Name, Version: m.Version, Publisher: m.Publisher, License: m.License, Repository: m.Repository, ArtifactURL: artifact.URL, SHA256: artifact.SHA256, Entrypoint: artifact.Entrypoint, Actions: m.Actions, ApprovalActions: m.ApprovalActions, Runtime: m.Runtime, ActionSpecs: m.ActionSpecs, PeerProtocols: m.PeerProtocols, UI: m.UI, InstalledAt: time.Now().UnixMilli()}
		if err = writePluginMeta(dir, result); err != nil {
			_ = os.Remove(target)
			if hadOld {
				_ = os.Rename(backup, target)
			}
			return nil, err
		}
		_ = os.Remove(backup)
		return nil, nil
	})
	return result, err
}

func pluginPageDigest(meta installedPlugin) string {
	b, _ := json.Marshal(struct {
		Hash, Version string
		UI            *pluginUI
		Actions       []string
		Specs         map[string]pluginActionSpec
	}{meta.SHA256, meta.Version, meta.UI, meta.Actions, meta.ActionSpecs})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func (a *Agent) cancelLocalPluginTask(corr string) {
	a.taskMu.Lock()
	cancel := a.pluginTasks[corr]
	if cancel != nil {
		cancel()
	} else {
		if a.taskCancelled == nil {
			a.taskCancelled = map[string]bool{}
		}
		if len(a.taskCancelled) < 4096 {
			a.taskCancelled[corr] = true
		}
	}
	a.taskMu.Unlock()
	a.mu.Lock()
	if a.pending != nil && a.pending.Corr == corr {
		pending := a.pending
		a.pending = nil
		a.mu.Unlock()
		rejectPending(pending, errors.New("canceled locally"))
	} else {
		a.mu.Unlock()
	}
}
func (a *Agent) invalidatePluginPage(token string) {
	a.pageMu.Lock()
	page, ok := a.pages[token]
	delete(a.pages, token)
	pending := []string{}
	if ok {
		for corr, result := range page.Results {
			if result["status"] != "done" {
				pending = append(pending, corr)
			}
		}
	}
	a.pageMu.Unlock()
	for _, corr := range pending {
		a.cancelLocalPluginTask(corr)
	}
}
func (a *Agent) expirePluginPages() {
	a.pageMu.Lock()
	expired := []string{}
	for token, page := range a.pages {
		if time.Now().After(page.Expires) {
			expired = append(expired, token)
		}
	}
	a.pageMu.Unlock()
	for _, token := range expired {
		a.invalidatePluginPage(token)
	}
}
func (a *Agent) closePluginPage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token string `json:"page_token"`
	}
	if !decodeLocalRequest(w, r, &body) {
		return
	}
	a.invalidatePluginPage(body.Token)
	writeJSON(w, map[string]any{"ok": true})
}

// The local UI archives the package and its data. The existing remote uninstall
// operation retains its established semantics.
func (a *Agent) uninstallLocalPlugin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID string `json:"plugin_id"`
	}
	if !decodeLocalRequest(w, r, &body) {
		return
	}
	if _, err := cleanPluginID(body.ID); err != nil {
		http.Error(w, "invalid plugin id", 400)
		return
	}
	a.pageMu.Lock()
	tokens := []string{}
	for token, page := range a.pages {
		if page.ID == body.ID {
			tokens = append(tokens, token)
		}
	}
	a.pageMu.Unlock()
	for _, token := range tokens {
		a.invalidatePluginPage(token)
	}
	value, err := withPluginWriteLock(body.ID, func() (any, error) {
		dir, err := pluginDir(body.ID)
		if err != nil {
			return nil, err
		}
		if _, err = os.Stat(filepath.Join(dir, "metadata.json")); err != nil {
			return nil, err
		}
		archive := filepath.Join(filepath.Dir(dir), ".archive")
		if err = os.MkdirAll(archive, 0700); err != nil {
			return nil, err
		}
		destination := filepath.Join(archive, body.ID+"-"+fmt.Sprint(time.Now().UnixNano()))
		if err = os.Rename(dir, destination); err != nil {
			return nil, err
		}
		return map[string]any{"id": body.ID, "removed": true, "data_archive": destination}, nil
	})
	if err != nil {
		http.Error(w, err.Error(), 409)
		return
	}
	a.record(activity.Event{PluginID: body.ID, Actor: "local", Kind: "plugin", Phase: "uninstalled", Source: "local", Summary: "Package and data archived"})
	writeJSON(w, value)
}
