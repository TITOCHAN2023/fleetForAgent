package main

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/TITOCHAN2023/fleetForAgent/internal/activity"
	"github.com/TITOCHAN2023/fleetForAgent/internal/receipts"
	"github.com/TITOCHAN2023/fleetForAgent/internal/vault"
)

func (a *Agent) journal() *activity.Store {
	a.activityMu.Lock()
	defer a.activityMu.Unlock()
	return a.activity
}
func (a *Agent) setJournal(s *activity.Store) {
	a.activityMu.Lock()
	a.activity = s
	a.activityMu.Unlock()
}
func (a *Agent) initStorage(dir string) error {
	a.storageDir = dir
	a.storageManager = vault.OpenManager(filepath.Join(dir, "storage"))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := a.storageManager.Load(ctx, nil)
	if errors.Is(err, vault.ErrLocked) {
		a.storageLocked.Store(true)
		a.hostObservations.Stop("storage_locked")
		a.storageError = "Unlock encrypted storage at the device"
		return nil
	}
	if err != nil && !errors.Is(err, vault.ErrUnconfigured) {
		return err
	}
	return a.openStorage(c)
}
func (a *Agent) openStorage(c *vault.Cipher) error {
	journal := a.journal()
	if journal != nil && journal.RequiresRecovery() {
		journal.Close()
		a.setJournal(nil)
		journal = nil
	}
	var err error
	if journal == nil {
		journal, err = activity.OpenEncrypted(filepath.Join(a.storageDir, "activity"), c)
	} else if c != nil {
		err = journal.EnableEncryption(c)
	}
	if err != nil {
		return err
	}
	a.setJournal(journal)
	a.taskMu.Lock()
	ledger := a.invocationReceipts
	if ledger == nil {
		ledger, err = receipts.Open(filepath.Join(a.storageDir, "invocations"), c)
	} else if c != nil {
		err = ledger.EnableEncryption(c)
	}
	if err == nil {
		a.invocationReceipts = ledger
	}
	a.taskMu.Unlock()
	if err != nil {
		return err
	}
	a.storageCipher = c
	a.storageLocked.Store(false)
	a.storageError = ""
	return nil
}
func (a *Agent) storageStatus() map[string]any {
	a.storageMu.Lock()
	defer a.storageMu.Unlock()
	mode := ""
	configured := false
	if a.storageManager != nil {
		mode, _ = a.storageManager.Mode()
		configured = mode != ""
	}
	journal := a.journal()
	encrypted := journal != nil && journal.Encrypted()
	a.taskMu.Lock()
	ledger := a.invocationReceipts
	a.taskMu.Unlock()
	return map[string]any{"configured": configured, "provider": mode, "locked": a.storageLocked.Load(), "activity_encrypted": encrypted, "receipts_encrypted": ledger != nil && ledger.Encrypted(), "error": a.storageError}
}
func (a *Agent) registerStorage(mux *http.ServeMux) {
	mux.HandleFunc("/api/plugin-storage-key", a.pluginStorageKey)
	mux.HandleFunc("/api/storage", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, a.storageStatus()) })
	mux.HandleFunc("/api/storage/setup", func(w http.ResponseWriter, r *http.Request) { a.changeStorage(w, r, true) })
	mux.HandleFunc("/api/storage/unlock", func(w http.ResponseWriter, r *http.Request) { a.changeStorage(w, r, false) })
}
func (a *Agent) changeStorage(w http.ResponseWriter, r *http.Request, setup bool) {
	var body struct {
		Password string `json:"password"`
	}
	if !decodeLocalRequest(w, r, &body) {
		return
	}
	password := []byte(body.Password)
	defer clear(password)
	body.Password = ""
	a.storageMu.Lock()
	defer a.storageMu.Unlock()
	if a.storageManager == nil {
		http.Error(w, "storage manager unavailable", 503)
		return
	}
	a.mu.Lock()
	disabled := !a.enabled
	peerCount := len(a.peerSessions)
	panes := a.panes
	a.mu.Unlock()
	a.taskMu.Lock()
	tasks := len(a.pluginTasks)
	a.taskMu.Unlock()
	if !disabled || peerCount > 0 || tasks > 0 || a.activeInputCount() > 0 || panes != nil && panes.Busy() {
		http.Error(w, "Disable the device and finish running tasks before changing storage", 409)
		return
	}
	a.storageLocked.Store(true)
	a.hostObservations.Stop("storage_locked")
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	var c *vault.Cipher
	var err error
	if setup {
		c, err = a.storageManager.Setup(ctx, password)
	} else {
		c, err = a.storageManager.Load(ctx, password)
	}
	if err == nil {
		err = a.openStorage(c)
	}
	if err != nil {
		a.storageError = "Storage configuration or unlock failed"
		if _, modeErr := a.storageManager.Mode(); errors.Is(modeErr, vault.ErrUnconfigured) {
			a.storageLocked.Store(false)
		}
		http.Error(w, a.storageError, 409)
		return
	}
	a.record(activity.Event{Actor: "local", Kind: "control", Phase: "completed", Source: "local", Summary: "Encrypted storage configured or unlocked"})
	writeJSON(w, map[string]any{"ok": true, "activity_encrypted": true, "receipts_encrypted": true})
}

func (a *Agent) releaseStorageForHandoff() error {
	a.storageMu.Lock()
	defer a.storageMu.Unlock()
	a.storageLocked.Store(true)
	a.hostObservations.Stop("storage_locked")
	deadline := time.Now().Add(5 * time.Second)
	for {
		a.taskMu.Lock()
		count := len(a.pluginTasks)
		a.taskMu.Unlock()
		if count == 0 {
			break
		}
		if time.Now().After(deadline) {
			return errors.New("plugin tasks did not finish before storage handoff")
		}
		time.Sleep(20 * time.Millisecond)
	}
	a.taskMu.Lock()
	if a.invocationReceipts != nil {
		a.invocationReceipts.Close()
		a.invocationReceipts = nil
	}
	a.taskMu.Unlock()
	journal := a.journal()
	a.setJournal(nil)
	if journal != nil {
		return journal.Close()
	}
	return nil
}
func (a *Agent) restoreStorageAfterHandoff() error {
	a.storageMu.Lock()
	defer a.storageMu.Unlock()
	if a.storageDir == "" {
		a.storageLocked.Store(false)
		return nil
	}
	return a.openStorage(a.storageCipher)
}

// Only a verified plugin invocation receives a key derived for its own data.
// The device master key is never returned by this endpoint.
func (a *Agent) pluginStorageKey(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	a.activityMu.Lock()
	scope, ok := a.pluginScopes[token]
	a.activityMu.Unlock()
	if !ok || time.Now().After(scope.Expires) {
		http.Error(w, "invalid invocation", 403)
		return
	}
	a.storageMu.Lock()
	c := a.storageCipher
	locked := a.storageLocked.Load()
	a.storageMu.Unlock()
	if locked {
		http.Error(w, "encrypted storage locked", 423)
		return
	}
	if c == nil {
		writeJSON(w, map[string]any{"encrypted": false})
		return
	}
	key := c.Derive("plugin-data/" + scope.PluginID)
	defer clear(key)
	writeJSON(w, map[string]any{"encrypted": true, "key": key})
}
