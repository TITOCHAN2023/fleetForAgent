//go:build darwin

package vault

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"os/exec"
	"strings"
)

type keychainStore struct{}

func systemKeyStore(string) KeyStore { return keychainStore{} }
func (keychainStore) Load(ctx context.Context, id string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "/usr/bin/security", "find-generic-password", "-s", "cc.ginfo.fleet.storage", "-a", id, "-w")
	b, err := cmd.Output()
	if err != nil {
		return nil, ErrLocked
	}
	defer clear(b)
	key, err := hex.DecodeString(strings.TrimSpace(string(b)))
	if err != nil || len(key) != 32 {
		return nil, ErrLocked
	}
	return key, nil
}
func (keychainStore) Save(ctx context.Context, id string, key []byte) error {
	if len(id) != 32 || len(key) != 32 {
		return errors.New("invalid keychain item")
	}
	// Sensitive key material is passed on stdin, never in argv or environment.
	input := []byte("add-generic-password -s cc.ginfo.fleet.storage -a " + id + " -w " + hex.EncodeToString(key) + "\n")
	defer clear(input)
	cmd := exec.CommandContext(ctx, "/usr/bin/security", "-i")
	cmd.Stdin = bytes.NewReader(input)
	if err := cmd.Run(); err != nil {
		return errors.New("keychain write failed")
	}
	return nil
}
