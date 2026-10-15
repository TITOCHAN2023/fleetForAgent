//go:build darwin

package vault

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"os/exec"
	"testing"
	"time"
)

// Opt-in integration test creates and deletes only its own synthetic item.
func TestMacKeychainSystemStoreRoundTrip(t *testing.T) {
	if os.Getenv("FLEET_VAULT_SYSTEM_TEST") != "1" {
		t.Skip("system keychain test is opt-in")
	}
	var idBytes [16]byte
	if _, err := rand.Read(idBytes[:]); err != nil {
		t.Fatal(err)
	}
	id := hex.EncodeToString(idBytes[:])
	key := bytes.Repeat([]byte{42}, 32)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		if err := exec.CommandContext(cleanup, "/usr/bin/security", "delete-generic-password", "-s", "cc.ginfo.fleet.storage", "-a", id).Run(); err != nil {
			t.Error("synthetic keychain item cleanup failed")
		}
	}()
	store := keychainStore{}
	if err := store.Save(ctx, id, key); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Load(ctx, id)
	defer clear(restored)
	if err != nil || !bytes.Equal(restored, key) {
		t.Fatal("system keychain did not restore fixture key")
	}
}
