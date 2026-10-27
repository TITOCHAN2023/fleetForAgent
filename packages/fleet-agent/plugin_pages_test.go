package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TITOCHAN2023/fleetForAgent/internal/activity"
)

func pageFixture(t *testing.T) (*Agent, http.Handler, string) {
	t.Helper()
	meta := installPluginTestBinary(t)
	meta.Actions = append(meta.Actions, "ui", "inspect", "configure")
	meta.UI = &pluginUI{Title: "Example", PageAction: "ui", ReadActions: []string{"inspect"}, WriteActions: []string{"configure"}}
	dir, err := pluginDir(meta.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = writePluginMeta(dir, meta); err != nil {
		t.Fatal(err)
	}
	original := invokePluginTask
	t.Cleanup(func() { invokePluginTask = original })
	invokePluginTask = func(ctx context.Context, req pluginRequest) (any, error) {
		if req.Action == "ui" {
			return map[string]any{"html": "<html><body>Example</body></html>"}, nil
		}
		inv, _ := ctx.Value(pluginInvocationKey{}).(pluginInvocation)
		return map[string]any{"action": req.Action, "origin": inv.Origin}, nil
	}
	a := &Agent{enabled: true, permit: PermitAllow}
	mux := http.NewServeMux()
	a.registerPluginPages(mux)
	handler := secureSettingsHandler(mux)
	response := localPageRequest(handler, "POST", "/api/plugins/open", `{"plugin_id":"fleet.transfer"}`)
	if response.Code != 200 {
		t.Fatalf("open page: %d %s", response.Code, response.Body)
	}
	var body struct {
		Token string `json:"page_token"`
	}
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if body.Token == "" {
		t.Fatal("missing scoped page token")
	}
	return a, handler, body.Token
}
func localPageRequest(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1:17890"+path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}
func TestPluginPageBridgeRejectsUndeclaredActionsAndExpiredPages(t *testing.T) {
	a, h, token := pageFixture(t)
	for _, action := range []string{"ui", "hang", "approve", "../../api/permit"} {
		b, _ := json.Marshal(map[string]any{"page_token": token, "action": action, "input": map[string]any{}})
		w := localPageRequest(h, "POST", "/api/plugins/invoke", string(b))
		if w.Code != 403 {
			t.Fatalf("unscoped action %s got %d", action, w.Code)
		}
	}
	a.pageMu.Lock()
	p := a.pages[token]
	p.Expires = time.Now().Add(-time.Second)
	a.pages[token] = p
	a.pageMu.Unlock()
	b, _ := json.Marshal(map[string]any{"page_token": token, "action": "inspect"})
	if w := localPageRequest(h, "POST", "/api/plugins/invoke", string(b)); w.Code != 403 {
		t.Fatal("expired page accepted")
	}
}
func TestPluginPageInvalidatesAfterExecutableTampering(t *testing.T) {
	_, h, token := pageFixture(t)
	meta, dir, err := readPluginMeta("fleet.transfer")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, meta.Entrypoint), []byte("tampered"), 0700); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(map[string]any{"page_token": token, "action": "inspect"})
	if w := localPageRequest(h, "POST", "/api/plugins/invoke", string(b)); w.Code != 403 {
		t.Fatal("tampered executable accepted")
	}
}
func TestPluginPageWriteStillHonorsDevicePermit(t *testing.T) {
	a, h, token := pageFixture(t)
	a.permit = PermitOff
	b, _ := json.Marshal(map[string]any{"page_token": token, "action": "configure", "input": map[string]any{}})
	w := localPageRequest(h, "POST", "/api/plugins/invoke", string(b))
	if w.Code != 200 {
		t.Fatalf("invoke: %d %s", w.Code, w.Body)
	}
	var body struct {
		Corr string `json:"corr"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	w = localPageRequest(h, "GET", "/api/plugins/result?page_token="+token+"&corr="+body.Corr, "")
	if !strings.Contains(w.Body.String(), "permit=off") {
		t.Fatalf("off result: %s", w.Body)
	}
}
func TestPluginTaskCancellationAndTrustedLocalContext(t *testing.T) {
	a, _, _ := pageFixture(t)
	started := make(chan pluginInvocation, 1)
	original := invokePluginTask
	defer func() { invokePluginTask = original }()
	invokePluginTask = func(ctx context.Context, _ pluginRequest) (any, error) {
		inv, _ := ctx.Value(pluginInvocationKey{}).(pluginInvocation)
		started <- inv
		<-ctx.Done()
		return nil, ctx.Err()
	}
	done := make(chan struct{})
	go func() {
		a.executePlugin(context.Background(), func(context.Context, Envelope) error { return nil }, "cancel-test", pluginRequest{Operation: "invoke", PluginID: "fleet.transfer", Action: "configure", Local: true})
		close(done)
	}()
	select {
	case inv := <-started:
		if inv.Origin != "local" || inv.Corr != "cancel-test" {
			t.Fatalf("untrusted invocation %#v", inv)
		}
	case <-time.After(time.Second):
		t.Fatal("did not start")
	}
	a.cancelPluginTasks()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancellation did not reach plugin")
	}
}
func TestActivitySinkRecordsOutcomeWithoutScreenshotOrTypedContent(t *testing.T) {
	store, err := activity.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	a := &Agent{activity: store}
	a.activityRequest(Envelope{Type: "desktop_action", Corr: "desktop-1", Body: map[string]any{"action": "type", "text": "private-input"}})
	_ = a.activitySink(func(context.Context, Envelope) error { return nil })(context.Background(), Envelope{Type: "desktop", Corr: "desktop-1", Body: map[string]any{"ok": true, "image_b64": "private-image"}})
	p, err := store.Read(activity.Query{})
	if err != nil || len(p.Events) != 2 {
		t.Fatalf("events %#v %v", p, err)
	}
	b, _ := json.Marshal(p)
	if strings.Contains(string(b), "private-input") || strings.Contains(string(b), "private-image") {
		t.Fatal("sensitive desktop content retained")
	}
}

func TestPluginPageInvalidatesWhenDeclarationsChange(t *testing.T) {
	_, h, token := pageFixture(t)
	meta, dir, err := readPluginMeta("fleet.transfer")
	if err != nil {
		t.Fatal(err)
	}
	meta.UI.ReadActions = []string{"configure"}
	meta.UI.WriteActions = []string{"inspect"}
	if err = writePluginMeta(dir, meta); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(map[string]any{"page_token": token, "action": "inspect"})
	if w := localPageRequest(h, "POST", "/api/plugins/invoke", string(b)); w.Code != 403 {
		t.Fatal("changed declaration retained old page authority")
	}
}

func TestOfficialRepositorySupportsExistingMixedCaseRepository(t *testing.T) {
	if _, err := officialRepositoryPath("https://github.com/TITOCHAN2023/fleetForAgent"); err != nil {
		t.Fatal(err)
	}
	for _, url := range []string{"https://github.com/other/fleetForAgent", "https://github.com/TITOCHAN2023/../other", "https://github.com/TITOCHAN2023/fleetForAgent?token=bad"} {
		if _, err := officialRepositoryPath(url); err == nil {
			t.Fatal("untrusted repository accepted")
		}
	}
}

func TestClosingPluginPageCancelsRunningTaskAndRevokesItsToken(t *testing.T) {
	a, h, token := pageFixture(t)
	started, canceled := make(chan struct{}), make(chan struct{})
	invokePluginTask = func(ctx context.Context, req pluginRequest) (any, error) {
		close(started)
		<-ctx.Done()
		close(canceled)
		return nil, ctx.Err()
	}
	request, _ := json.Marshal(map[string]any{"page_token": token, "action": "inspect"})
	response := localPageRequest(h, "POST", "/api/plugins/invoke", string(request))
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("not started")
	}
	closeRequest, _ := json.Marshal(map[string]any{"page_token": token})
	response = localPageRequest(h, "POST", "/api/plugins/close", string(closeRequest))
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("page close did not cancel task")
	}
	if _, _, err := a.pageSession(token); err == nil {
		t.Fatal("closed page token still usable")
	}
}
func TestLocalUninstallArchivesPluginDataAndRevokesPages(t *testing.T) {
	a, h, token := pageFixture(t)
	page, _, err := a.pageSession(token)
	if err != nil {
		t.Fatal(err)
	}
	dir, err := pluginDir(page.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Join(dir, "data"), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "data", "proof.txt"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	request, _ := json.Marshal(map[string]any{"plugin_id": page.ID})
	response := localPageRequest(h, "POST", "/api/plugins/uninstall-local", string(request))
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	var result struct {
		Archive string `json:"data_archive"`
	}
	if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	proof, err := os.ReadFile(filepath.Join(result.Archive, "data", "proof.txt"))
	if err != nil || string(proof) != "keep" {
		t.Fatal("plugin data not retained")
	}
	if _, _, err = a.pageSession(token); err == nil {
		t.Fatal("uninstalled page stayed authorized")
	}
	rows, err := listInstalledPlugins()
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if row.ID == page.ID {
			t.Fatal("uninstalled plugin still in inventory")
		}
	}
}
func TestPluginActivityUsesTrustedScopeAndReportsJournalFailure(t *testing.T) {
	journal, err := activity.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	a := &Agent{activity: journal, deviceID: "test-device"}
	token, release := a.registerPluginScope("example.plugin", "test-corr", "trusted-operator")
	defer release()
	call := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://127.0.0.1:17890/api/plugin-activity", strings.NewReader(`{"kind":"process","phase":"started","source":"core","actor":"forged","corr":"forged","plugin_id":"forged"}`))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		a.servePluginActivity(w, r)
		return w
	}
	if w := call(); w.Code != 200 {
		t.Fatalf("event: %d %s", w.Code, w.Body)
	}
	page, err := journal.Read(activity.Query{})
	if err != nil || len(page.Events) != 1 {
		t.Fatal(err)
	}
	e := page.Events[0]
	if e.Corr != "test-corr" || e.PluginID != "example.plugin" || e.Actor != "trusted-operator" || e.Source != "plugin" || e.DeviceID != "test-device" {
		t.Fatalf("untrusted scope retained: %#v", e)
	}
	if err = journal.Close(); err != nil {
		t.Fatal(err)
	}
	if w := call(); w.Code != 503 {
		t.Fatalf("failed durable write acknowledged: %d", w.Code)
	}
}

func TestActivitySinkRetainsTheCallerCapturedBeforeIdentityRevocation(t *testing.T) {
	journal, err := activity.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	a := &Agent{activity: journal, authKid: "first-operator", deviceID: "fixture-device"}
	ctx := context.WithValue(context.Background(), pluginPrincipalKey{}, a.activityActor(context.Background()))
	a.mu.Lock()
	a.authKid = "replacement-operator"
	a.mu.Unlock()
	sink := a.activitySink(func(context.Context, Envelope) error { return nil })
	if err = sink(ctx, resultEnv("fixture-corr", true, 0, "", "")); err != nil {
		t.Fatal(err)
	}
	page, err := journal.Read(activity.Query{})
	if err != nil || len(page.Events) != 1 || page.Events[0].Actor != "first-operator" {
		t.Fatalf("caller changed mid invocation: %#v %v", page, err)
	}
}
