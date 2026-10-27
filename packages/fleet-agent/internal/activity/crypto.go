package activity

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/TITOCHAN2023/fleetForAgent/internal/vault"
	"io"
	"os"
	"path/filepath"
)

type encryptedRecord struct {
	Version int    `json:"v"`
	Seq     uint64 `json:"seq"`
	Box     []byte `json:"box"`
}

func encodeEvent(c *vault.Cipher, e Event) ([]byte, error) {
	b, err := json.Marshal(e)
	if len(b)+1 >= maxRecord {
		return nil, errors.New("activity event too large")
	}
	if err != nil || c == nil {
		return b, err
	}
	box, err := c.Seal(fmt.Sprintf("activity/%d", e.Seq), b)
	if err != nil {
		return nil, err
	}
	return json.Marshal(encryptedRecord{1, e.Seq, box})
}
func decodeEvent(c *vault.Cipher, line []byte) (Event, error) {
	var e Event
	if c == nil {
		err := json.Unmarshal(line, &e)
		return e, err
	}
	var record encryptedRecord
	if json.Unmarshal(line, &record) != nil || record.Version != 1 || record.Seq == 0 {
		return e, errors.New("invalid encrypted journal record")
	}
	b, err := c.Open(fmt.Sprintf("activity/%d", record.Seq), record.Box)
	if err != nil {
		return e, err
	}
	if json.Unmarshal(b, &e) != nil || e.Seq != record.Seq {
		return e, errors.New("encrypted journal sequence mismatch")
	}
	return e, nil
}
func (s *Store) scan(path string, visit func(Event) error) (uint64, int64, bool, error) {
	return scanDecoded(path, func(b []byte) (Event, error) { return decodeEvent(s.cipher, b) }, visit)
}
func (s *Store) Encrypted() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.cipher != nil }
func (s *Store) EnableEncryption(c *vault.Cipher) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c == nil {
		return errors.New("storage key required")
	}
	if s.cipher != nil {
		return nil
	}
	if s.file == nil || s.failed != nil {
		return errors.New("journal requires recovery before encryption")
	}
	dir := filepath.Dir(s.path)
	if err := s.file.Close(); err != nil {
		return err
	}
	s.file = nil
	if err := migrateJournal(dir, c, s.seq); err != nil {
		s.failed = err
		return err
	}
	s.path = filepath.Join(dir, "events.enc.jsonl")
	s.cipher = c
	f, err := os.OpenFile(s.path, os.O_APPEND|os.O_WRONLY, 0600)
	s.file = f
	return err
}

type migration struct {
	Last uint64 `json:"last"`
}

func migrateJournal(dir string, c *vault.Cipher, last uint64) error {
	marker := filepath.Join(dir, "migration.json")
	state := migration{Last: last}
	if b, err := os.ReadFile(marker); err == nil {
		if json.Unmarshal(b, &state) != nil {
			return errors.New("invalid journal migration marker")
		}
	} else if !os.IsNotExist(err) {
		return err
	} else {
		b, _ := json.Marshal(state)
		if err = vault.WriteAtomic(marker, b); err != nil {
			return err
		}
	}
	for _, suffix := range []string{".previous", ""} {
		source := filepath.Join(dir, "events.jsonl"+suffix)
		target := filepath.Join(dir, "events.enc.jsonl"+suffix)
		if _, err := os.Lstat(source); os.IsNotExist(err) {
			continue
		} else if err != nil {
			return err
		}
		f, err := os.CreateTemp(dir, ".journal-*")
		if err != nil {
			return err
		}
		_, _, tail, err := scan(source, func(e Event) error {
			b, eErr := encodeEvent(c, e)
			if eErr != nil {
				return eErr
			}
			_, eErr = f.Write(append(b, '\n'))
			return eErr
		})
		if err == nil && tail {
			err = errors.New("incomplete source journal requires recovery")
		}
		if err == nil {
			err = f.Sync()
		}
		closeErr := f.Close()
		if err == nil {
			err = closeErr
		}
		if err == nil {
			err = replaceJournal(f.Name(), target)
		}
		os.Remove(f.Name())
		if err != nil {
			return err
		}
	}
	var observed uint64
	for _, suffix := range []string{".previous", ""} {
		_, _, tail, err := scanDecoded(filepath.Join(dir, "events.enc.jsonl"+suffix), func(b []byte) (Event, error) { return decodeEvent(c, b) }, func(e Event) error {
			if observed > 0 && e.Seq != observed+1 {
				return errors.New("journal migration sequence gap")
			}
			observed = e.Seq
			return nil
		})
		if err != nil {
			return err
		}
		if tail {
			return io.ErrUnexpectedEOF
		}
	}
	if observed != state.Last {
		return errors.New("journal migration did not preserve its complete sequence")
	}
	// Both new segments are flushed and authenticated before removing originals.
	for _, suffix := range []string{".previous", ""} {
		if err := os.Remove(filepath.Join(dir, "events.jsonl"+suffix)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return os.Remove(marker)
}

func prepareEncryptedJournal(dir string, c *vault.Cipher) error {
	if _, err := os.Lstat(filepath.Join(dir, "migration.json")); err == nil {
		return migrateJournal(dir, c, 0)
	} else if !os.IsNotExist(err) {
		return err
	}
	plain, encrypted := false, false
	for _, suffix := range []string{".previous", ""} {
		if _, err := os.Lstat(filepath.Join(dir, "events.jsonl"+suffix)); err == nil {
			plain = true
		}
		if _, err := os.Lstat(filepath.Join(dir, "events.enc.jsonl"+suffix)); err == nil {
			encrypted = true
		}
	}
	if !plain {
		return nil
	}
	if encrypted {
		return errors.New("mixed plaintext and encrypted journals require explicit recovery")
	}
	var last uint64
	for _, suffix := range []string{".previous", ""} {
		path := filepath.Join(dir, "events.jsonl"+suffix)
		_, valid, tail, err := scan(path, func(e Event) error {
			if last > 0 && e.Seq != last+1 {
				return errors.New("source journal sequence gap")
			}
			last = e.Seq
			return nil
		})
		if err != nil {
			return err
		}
		if tail {
			if suffix != "" {
				return errors.New("archived journal tail incomplete")
			}
			if err = os.Truncate(path, valid); err != nil {
				return err
			}
		}
	}
	return migrateJournal(dir, c, last)
}

func (s *Store) RequiresRecovery() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.file == nil || s.failed != nil
}
