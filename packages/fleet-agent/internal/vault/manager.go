package vault

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"

	"golang.org/x/crypto/argon2"
)

var ErrUnconfigured = errors.New("encrypted storage is not configured")
var ErrLocked = errors.New("encrypted storage is locked or its key is unavailable")

type KeyStore interface {
	Load(context.Context, string) ([]byte, error)
	Save(context.Context, string, []byte) error
}
type Config struct {
	Version int    `json:"version"`
	Mode    string `json:"mode"`
	KeyID   string `json:"key_id"`
	Salt    []byte `json:"salt,omitempty"`
	Wrapped []byte `json:"wrapped,omitempty"`
}
type Manager struct {
	dir  string
	keys KeyStore
}

func NewManager(dir string, keys KeyStore) *Manager { return &Manager{dir: dir, keys: keys} }
func OpenManager(dir string) *Manager               { return NewManager(dir, systemKeyStore(dir)) }
func (m *Manager) config() (Config, error) {
	var cfg Config
	path := filepath.Join(m.dir, "key.json")
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return cfg, ErrUnconfigured
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4096 {
		return cfg, errors.New("invalid storage key configuration")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return cfg, err
	}
	if json.Unmarshal(b, &cfg) != nil || cfg.Version != 1 || len(cfg.KeyID) != 32 {
		return cfg, errors.New("invalid storage key configuration")
	}
	if _, err = hex.DecodeString(cfg.KeyID); err != nil {
		return cfg, err
	}
	if cfg.Mode != "system" && cfg.Mode != "password" {
		return cfg, errors.New("unsupported storage key provider")
	}
	if cfg.Mode == "password" && (len(cfg.Salt) != 16 || len(cfg.Wrapped) > 1024) {
		return cfg, errors.New("invalid password wrapping parameters")
	}
	return cfg, nil
}
func (m *Manager) Mode() (string, error) { cfg, err := m.config(); return cfg.Mode, err }
func passwordCipher(password, salt []byte) (*Cipher, error) {
	// RFC 9106 memory-constrained profile. Parameters are fixed, not controlled
	// by an untrusted key.json file, so loading cannot request unbounded RAM.
	key := argon2.IDKey(password, salt, 3, 64*1024, 4, 32)
	defer clear(key)
	return New(key)
}
func (m *Manager) Load(ctx context.Context, password []byte) (*Cipher, error) {
	cfg, err := m.config()
	if err != nil {
		return nil, err
	}
	var key []byte
	if cfg.Mode == "system" {
		key, err = m.keys.Load(ctx, cfg.KeyID)
	} else {
		if len(password) == 0 {
			return nil, ErrLocked
		}
		wrap, e := passwordCipher(password, cfg.Salt)
		if e != nil {
			return nil, e
		}
		key, err = wrap.Open("master/"+cfg.KeyID, cfg.Wrapped)
	}
	if err != nil {
		return nil, ErrLocked
	}
	defer clear(key)
	c, err := New(key)
	if err != nil {
		return nil, ErrLocked
	}
	return c, nil
}
func (m *Manager) Setup(ctx context.Context, password []byte) (*Cipher, error) {
	if _, err := m.config(); err != ErrUnconfigured {
		if err == nil {
			return nil, errors.New("storage key already configured")
		}
		return nil, err
	}
	if err := os.MkdirAll(m.dir, 0700); err != nil {
		return nil, err
	}
	key := make([]byte, 32)
	defer clear(key)
	id := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, err
	}
	if _, err := io.ReadFull(rand.Reader, id); err != nil {
		return nil, err
	}
	cfg := Config{Version: 1, KeyID: hex.EncodeToString(id), Mode: "system"}
	if len(password) == 0 {
		if err := m.keys.Save(ctx, cfg.KeyID, key); err != nil {
			return nil, errors.New("system key store could not save storage key")
		}
		check, err := m.keys.Load(ctx, cfg.KeyID)
		valid := err == nil && len(check) == 32 && subtle.ConstantTimeCompare(check, key) == 1
		clear(check)
		if !valid {
			return nil, errors.New("system key store verification failed")
		}
	} else {
		if len(password) < 12 || len(password) > 4096 {
			return nil, errors.New("storage passphrase must contain 12 to 4096 bytes")
		}
		cfg.Mode = "password"
		cfg.Salt = make([]byte, 16)
		if _, err := io.ReadFull(rand.Reader, cfg.Salt); err != nil {
			return nil, err
		}
		wrap, err := passwordCipher(password, cfg.Salt)
		if err != nil {
			return nil, err
		}
		cfg.Wrapped, err = wrap.Seal("master/"+cfg.KeyID, key)
		if err != nil {
			return nil, err
		}
	}
	b, err := json.Marshal(cfg)
	if err != nil {
		return nil, err
	}
	if err = writeConfigExclusive(m.dir, b); err != nil {
		return nil, err
	}
	return New(key)
}
func writeConfigExclusive(dir string, b []byte) error {
	// Publish a fully flushed file without replacing any existing configuration.
	tmp, err := os.CreateTemp(dir, ".key-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err = tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err = tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	return publishConfig(tmp.Name(), filepath.Join(dir, "key.json"))
}
