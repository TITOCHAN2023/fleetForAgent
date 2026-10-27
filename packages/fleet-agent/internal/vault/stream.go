package vault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
)

const streamChunk = 64 << 10

var streamMagic = []byte("FLEETSTREAM1")

func (c *Cipher) streamAEAD(purpose string, id []byte) (cipher.AEAD, error) {
	key := c.Derive("stream/" + purpose + "/" + hex.EncodeToString(id))
	defer clear(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
func streamNonce(counter uint64) []byte {
	nonce := make([]byte, 12)
	binary.BigEndian.PutUint64(nonce[4:], counter)
	return nonce
}
func streamAAD(header []byte, purpose string, counter uint64, n uint32) []byte {
	out := append([]byte{}, header...)
	out = append(out, []byte(purpose)...)
	var data [12]byte
	binary.BigEndian.PutUint64(data[:8], counter)
	binary.BigEndian.PutUint32(data[8:], n)
	return append(out, data[:]...)
}
func (c *Cipher) SealStream(purpose string, r io.Reader, w io.Writer) error {
	if purpose == "" {
		return errors.New("stream purpose required")
	}
	id := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, id); err != nil {
		return err
	}
	header := append(append([]byte{}, streamMagic...), id...)
	if err := writeAll(w, header); err != nil {
		return err
	}
	a, err := c.streamAEAD(purpose, id)
	if err != nil {
		return err
	}
	buffer := make([]byte, streamChunk)
	defer clear(buffer)
	for counter := uint64(0); ; counter++ {
		n, readErr := io.ReadFull(r, buffer)
		if readErr != nil && readErr != io.EOF && readErr != io.ErrUnexpectedEOF {
			return readErr
		}
		var length [4]byte
		binary.BigEndian.PutUint32(length[:], uint32(n))
		box := a.Seal(nil, streamNonce(counter), buffer[:n], streamAAD(header, purpose, counter, uint32(n)))
		if err = writeAll(w, length[:]); err != nil {
			return err
		}
		if err = writeAll(w, box); err != nil {
			return err
		}
		if n == 0 {
			return nil
		} // Authenticated final record, required by the reader.
	}
}
func (c *Cipher) OpenStream(purpose string, r io.Reader, w io.Writer, maxBytes int64) error {
	header := make([]byte, len(streamMagic)+16)
	if _, err := io.ReadFull(r, header); err != nil {
		return err
	}
	if string(header[:len(streamMagic)]) != string(streamMagic) || purpose == "" {
		return errors.New("invalid encrypted stream")
	}
	a, err := c.streamAEAD(purpose, header[len(streamMagic):])
	if err != nil {
		return err
	}
	var total int64
	for counter := uint64(0); ; counter++ {
		var length [4]byte
		if _, err = io.ReadFull(r, length[:]); err != nil {
			return errors.New("encrypted stream has no authenticated end")
		}
		n := binary.BigEndian.Uint32(length[:])
		total += int64(n)
		if n > streamChunk || maxBytes >= 0 && total > maxBytes {
			return errors.New("encrypted stream limit exceeded")
		}
		box := make([]byte, int(n)+a.Overhead())
		if _, err = io.ReadFull(r, box); err != nil {
			return err
		}
		plain, e := a.Open(nil, streamNonce(counter), box, streamAAD(header, purpose, counter, n))
		if e != nil {
			return errors.New("stream authentication failed")
		}
		if n == 0 {
			var trailing [1]byte
			count, e := r.Read(trailing[:])
			if count != 0 || e != io.EOF {
				return errors.New("encrypted stream has trailing data")
			}
			return nil
		}
		err = writeAll(w, plain)
		clear(plain)
		if err != nil {
			return err
		}
	}
}
func writeAll(w io.Writer, b []byte) error {
	n, err := w.Write(b)
	if err == nil && n != len(b) {
		err = io.ErrShortWrite
	}
	return err
}
