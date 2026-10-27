// Package vault provides authenticated, device-local storage. It never writes a
// plaintext master key and never silently regenerates a missing existing key.
package vault

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"io"
)

var magic = []byte("FLEETENC1")

type Cipher struct{ key [32]byte }

func New(key []byte) (*Cipher, error) {
	if len(key) != 32 {
		return nil, errors.New("storage key must be 256 bits")
	}
	c := &Cipher{}
	copy(c.key[:], key)
	return c, nil
}
func (c *Cipher) Derive(purpose string) []byte {
	h := hmac.New(sha256.New, c.key[:])
	h.Write([]byte("fleet.storage.key.v1\x00"))
	h.Write([]byte(purpose))
	return h.Sum(nil)
}
func (c *Cipher) aead(purpose string) (cipher.AEAD, error) {
	key := c.Derive(purpose)
	defer clear(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
func (c *Cipher) Seal(purpose string, plain []byte) ([]byte, error) {
	if purpose == "" {
		return nil, errors.New("storage purpose required")
	}
	a, err := c.aead(purpose)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, a.NonceSize())
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	out := append(append([]byte{}, magic...), nonce...)
	return a.Seal(out, nonce, plain, []byte("fleet.storage.v1\x00"+purpose)), nil
}
func (c *Cipher) Open(purpose string, blob []byte) ([]byte, error) {
	a, err := c.aead(purpose)
	if err != nil {
		return nil, err
	}
	if purpose == "" || len(blob) < len(magic)+a.NonceSize()+a.Overhead() || !bytes.Equal(blob[:len(magic)], magic) {
		return nil, errors.New("invalid encrypted storage object")
	}
	nonce := blob[len(magic) : len(magic)+a.NonceSize()]
	plain, err := a.Open(nil, nonce, blob[len(magic)+a.NonceSize():], []byte("fleet.storage.v1\x00"+purpose))
	if err != nil {
		return nil, errors.New("storage authentication failed")
	}
	return plain, nil
}
