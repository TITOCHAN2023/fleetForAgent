package vault

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

type memoryKeys struct{ values map[string][]byte }

func (k *memoryKeys) Load(_ context.Context, id string) ([]byte, error) {
	v, ok := k.values[id]
	if !ok {
		return nil, ErrLocked
	}
	return append([]byte{}, v...), nil
}
func (k *memoryKeys) Save(_ context.Context, id string, v []byte) error {
	if k.values == nil {
		k.values = map[string][]byte{}
	}
	k.values[id] = append([]byte{}, v...)
	return nil
}
func TestCipherAuthenticatesContentPurposeAndUsesNewNonce(t *testing.T) {
	c, _ := New(bytes.Repeat([]byte{42}, 32))
	first, _ := c.Seal("receipt/one", []byte("private result"))
	second, _ := c.Seal("receipt/one", []byte("private result"))
	if bytes.Equal(first, second) || bytes.Contains(first, []byte("private result")) {
		t.Fatal("plaintext or nonce reuse")
	}
	if _, err := c.Open("receipt/two", first); err == nil {
		t.Fatal("cross-object replay accepted")
	}
	first[len(first)-1] ^= 1
	if _, err := c.Open("receipt/one", first); err == nil {
		t.Fatal("tampered object accepted")
	}
}
func TestPasswordManagerSurvivesRestartWithoutPlaintextKey(t *testing.T) {
	dir := t.TempDir()
	m := NewManager(dir, &memoryKeys{})
	password := []byte("synthetic fixture passphrase")
	c, err := m.Setup(context.Background(), password)
	if err != nil {
		t.Fatal(err)
	}
	blob, _ := c.Seal("proof", []byte("private result"))
	again := NewManager(dir, &memoryKeys{})
	if _, err = again.Load(context.Background(), nil); !errors.Is(err, ErrLocked) {
		t.Fatal("locked storage opened")
	}
	if _, err = again.Load(context.Background(), []byte("wrong fixture password")); !errors.Is(err, ErrLocked) {
		t.Fatal("wrong passphrase accepted")
	}
	c, err = again.Load(context.Background(), password)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := c.Open("proof", blob)
	if err != nil || string(plain) != "private result" {
		t.Fatal("restart lost key")
	}
	b, _ := os.ReadFile(filepath.Join(dir, "key.json"))
	if bytes.Contains(b, password) {
		t.Fatal("passphrase persisted")
	}
	if _, err = again.Setup(context.Background(), password); err == nil {
		t.Fatal("existing key replaced")
	}
}
func TestMissingSystemKeyIsNeverRegenerated(t *testing.T) {
	keys := &memoryKeys{}
	dir := t.TempDir()
	m := NewManager(dir, keys)
	if _, err := m.Setup(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	keys.values = nil
	if _, err := m.Load(context.Background(), nil); !errors.Is(err, ErrLocked) {
		t.Fatal("missing key ignored")
	}
	if _, err := m.Setup(context.Background(), nil); err == nil {
		t.Fatal("lost key replaced")
	}
}

func TestStreamEncryptionRejectsTruncationReorderingAndWrongPurpose(t *testing.T) {
	c, _ := New(bytes.Repeat([]byte{42}, 32))
	plain := bytes.Repeat([]byte("private payload"), 15000)
	var encoded bytes.Buffer
	if err := c.SealStream("workspace/a", bytes.NewReader(plain), &encoded); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded.Bytes(), []byte("private payload")) {
		t.Fatal("stream contains plaintext")
	}
	var recovered bytes.Buffer
	if err := c.OpenStream("workspace/a", bytes.NewReader(encoded.Bytes()), &recovered, int64(len(plain))); err != nil || !bytes.Equal(recovered.Bytes(), plain) {
		t.Fatal("stream roundtrip failed")
	}
	for _, b := range [][]byte{encoded.Bytes()[:encoded.Len()-1], append(append([]byte{}, encoded.Bytes()...), 0)} {
		if err := c.OpenStream("workspace/a", bytes.NewReader(b), io.Discard, int64(len(plain))); err == nil {
			t.Fatal("invalid stream accepted")
		}
	}
	if err := c.OpenStream("workspace/b", bytes.NewReader(encoded.Bytes()), io.Discard, int64(len(plain))); err == nil {
		t.Fatal("cross-workspace replay accepted")
	}
	if err := c.OpenStream("workspace/a", bytes.NewReader(encoded.Bytes()), io.Discard, int64(len(plain)-1)); err == nil {
		t.Fatal("stream size bound ignored")
	}
	tampered := append([]byte{}, encoded.Bytes()...)
	tampered[len(streamMagic)+16+4+5] ^= 1
	if err := c.OpenStream("workspace/a", bytes.NewReader(tampered), io.Discard, int64(len(plain))); err == nil {
		t.Fatal("stream tamper accepted")
	}
}
