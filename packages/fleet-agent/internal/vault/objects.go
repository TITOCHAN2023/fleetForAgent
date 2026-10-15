package vault

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
)

const MaxObjectBytes = 16 << 20

type Objects struct {
	mu     sync.Mutex
	dir    string
	cipher *Cipher
}

func OpenObjects(dir string, c *Cipher) (*Objects, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	s := &Objects{dir: dir}
	if c != nil {
		if err := s.EnableEncryption(c); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// OpenObjectsStrict installs a cipher without scanning or rewriting existing
// objects. Encrypted reads reject plaintext. Use EnableEncryption explicitly
// when migrating an existing store, then publish its completion checkpoint.
func OpenObjectsStrict(dir string, c *Cipher) (*Objects, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	return &Objects{dir: dir, cipher: c}, nil
}
func objectName(id string) string {
	h := sha256.Sum256([]byte(id))
	return hex.EncodeToString(h[:]) + ".obj"
}
func (s *Objects) Read(id string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.read(id)
}
func (s *Objects) read(id string) ([]byte, error) {
	path := filepath.Join(s.dir, objectName(id))
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > MaxObjectBytes {
		return nil, errors.New("invalid storage object")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, errors.New("storage object changed")
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxObjectBytes+1))
	if err != nil || len(b) > MaxObjectBytes {
		return nil, errors.New("storage object read failed")
	}
	if s.cipher != nil {
		return s.cipher.Open("object/"+objectName(id), b)
	}
	if bytes.HasPrefix(b, magic) {
		return nil, ErrLocked
	}
	return b, nil
}
func (s *Objects) Write(id string, b []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(b) > MaxObjectBytes-1024 {
		return errors.New("storage object too large")
	}
	if s.cipher != nil {
		var err error
		b, err = s.cipher.Seal("object/"+objectName(id), b)
		if err != nil {
			return err
		}
	}
	return WriteAtomic(filepath.Join(s.dir, objectName(id)), b)
}
func (s *Objects) Remove(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return os.Remove(filepath.Join(s.dir, objectName(id)))
}
func (s *Objects) Encrypted() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.cipher != nil }
func (s *Objects) EnableEncryption(c *Cipher) error {
	return s.EnableEncryptionContext(context.Background(), c)
}

func (s *Objects) EnableEncryptionContext(ctx context.Context, c *Cipher) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c == nil {
		return ErrLocked
	}
	files, err := os.ReadDir(s.dir)
	if err != nil {
		return err
	}
	for _, entry := range files {
		if err := ctx.Err(); err != nil {
			return err
		}
		name := entry.Name()
		if filepath.Ext(name) != ".obj" {
			continue
		}
		if len(name) != 68 || entry.Type()&os.ModeSymlink != 0 {
			return errors.New("invalid object name")
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() > MaxObjectBytes {
			return errors.New("invalid object file")
		}
		b, err := os.ReadFile(filepath.Join(s.dir, name))
		if err != nil {
			return err
		}
		if bytes.HasPrefix(b, magic) {
			if _, err = c.Open("object/"+name, b); err != nil {
				return err
			}
			continue
		}
		box, err := c.Seal("object/"+name, b)
		if err != nil {
			return err
		}
		if err = WriteAtomic(filepath.Join(s.dir, name), box); err != nil {
			return err
		}
	}
	s.cipher = c
	return nil
}
