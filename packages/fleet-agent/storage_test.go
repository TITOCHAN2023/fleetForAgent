package main

import (
	"bytes"
	"encoding/json"
	"github.com/TITOCHAN2023/fleetForAgent/internal/activity"
	"github.com/TITOCHAN2023/fleetForAgent/internal/vault"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStoragePasswordSetupLockedRestartAndUnlock(t *testing.T) {
	root := t.TempDir()
	a := &Agent{}
	if err := a.initStorage(root); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	a.registerStorage(mux)
	h := secureSettingsHandler(mux)
	a.record(activity.Event{Kind: "command", Summary: "private fixture data"})
	password := "synthetic test passphrase"
	body, _ := json.Marshal(map[string]string{"password": password})
	w := localPageRequest(h, "POST", "/api/storage/setup", string(body))
	if w.Code != 200 {
		t.Fatalf("setup %d %s", w.Code, w.Body)
	}
	if !a.journal().Encrypted() || !a.invocationReceipts.Encrypted() {
		t.Fatal("not encrypted")
	}
	a.journal().Close()
	restarted := &Agent{enabled: true, permit: PermitAllow}
	if err := restarted.initStorage(root); err != nil {
		t.Fatal(err)
	}
	if !restarted.storageLocked.Load() || restarted.journal() != nil {
		t.Fatal("password vault silently opened")
	}
	restarted.mu.Lock()
	verdict, _ := restarted.inputVerdict()
	restarted.mu.Unlock()
	if verdict != permitRefuse {
		t.Fatal("locked vault executed")
	}
	restarted.enabled = false
	mux = http.NewServeMux()
	restarted.registerStorage(mux)
	h = secureSettingsHandler(mux)
	wrong, _ := json.Marshal(map[string]string{"password": "wrong fixture passphrase"})
	w = localPageRequest(h, "POST", "/api/storage/unlock", string(wrong))
	if w.Code != 409 {
		t.Fatal("wrong passphrase accepted")
	}
	w = localPageRequest(h, "POST", "/api/storage/unlock", string(body))
	if w.Code != 200 {
		t.Fatalf("unlock %d %s", w.Code, w.Body)
	}
	defer restarted.journal().Close()
	page, err := restarted.journal().Read(activity.Query{Kind: "command"})
	if err != nil || len(page.Events) != 1 || page.Events[0].Summary != "private fixture data" {
		t.Fatal("unlock lost history")
	}
	mode, err := restarted.storageManager.Mode()
	if err != nil || mode != "password" {
		t.Fatal("provider changed")
	}
}

func TestPluginStorageKeyIsDerivedAndScopedToTheVerifiedInvocation(t *testing.T) {
	c, _ := vault.New(bytes.Repeat([]byte{42}, 32))
	a := &Agent{storageCipher: c}
	one, releaseOne := a.registerPluginScope("one.plugin", "corr-one", "local")
	defer releaseOne()
	two, releaseTwo := a.registerPluginScope("two.plugin", "corr-two", "local")
	defer releaseTwo()
	fetch := func(token string) (int, []byte) {
		r := httptest.NewRequest("POST", "http://127.0.0.1:17890/api/plugin-storage-key", strings.NewReader("{}"))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		a.pluginStorageKey(w, r)
		var reply struct {
			Key []byte `json:"key"`
		}
		json.Unmarshal(w.Body.Bytes(), &reply)
		return w.Code, reply.Key
	}
	status, first := fetch(one)
	if status != 200 || len(first) != 32 {
		t.Fatal("missing plugin storage capability")
	}
	_, second := fetch(two)
	if bytes.Equal(first, second) {
		t.Fatal("different plugins shared storage key")
	}
	if status, _ = fetch("invalid"); status != 403 {
		t.Fatal("invalid invocation got key")
	}
	releaseOne()
	if status, _ = fetch(one); status != 403 {
		t.Fatal("revoked invocation got key")
	}
	a.storageLocked.Store(true)
	if status, _ = fetch(two); status != 423 {
		t.Fatal("locked device gave key")
	}
}
