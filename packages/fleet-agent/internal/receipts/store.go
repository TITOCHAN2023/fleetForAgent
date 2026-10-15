// Package receipts prevents duplicate execution across device restarts. A
// pending receipt has an unknown outcome and is never automatically rerun.
package receipts

import (
	"encoding/json"
	"errors"
	"github.com/TITOCHAN2023/fleetForAgent/internal/vault"
	"os"
	"sync"
	"time"
)

type Entry struct {
	Digest    string `json:"digest"`
	Expires   int64  `json:"expires"`
	Complete  bool   `json:"complete"`
	Retryable bool   `json:"retryable,omitempty"`
}
type Claim struct {
	Execute     bool
	Interrupted bool
	Reply       json.RawMessage
}
type Store struct {
	closed  bool
	mu      sync.Mutex
	objects *vault.Objects
	index   map[string]Entry
}

func Open(dir string, c *vault.Cipher) (*Store, error) {
	objects, err := vault.OpenObjects(dir, c)
	if err != nil {
		return nil, err
	}
	s := &Store{objects: objects, index: map[string]Entry{}}
	b, err := objects.Read("index")
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if json.Unmarshal(b, &s.index) != nil || len(s.index) > 512 {
		return nil, errors.New("invalid invocation receipt index")
	}
	for id, e := range s.index {
		if len(id) > 4096 || len(e.Digest) != 64 || e.Expires <= 0 {
			return nil, errors.New("invalid invocation receipt")
		}
	}
	return s, nil
}
func (s *Store) save(index map[string]Entry) error {
	b, err := json.Marshal(index)
	if err != nil {
		return err
	}
	return s.objects.Write("index", b)
}
func (s *Store) Claim(id, digest string, expires time.Time) (Claim, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(id) > 4096 || len(digest) != 64 {
		return Claim{}, errors.New("invalid invocation identity")
	}
	if s.closed {
		return Claim{}, errors.New("receipt store closed for handoff")
	}
	now := time.Now().UnixMilli()
	if e, ok := s.index[id]; ok && (!e.Complete || e.Expires >= now) {
		if e.Digest != digest {
			return Claim{}, errors.New("correlation reused with different input or caller")
		}
		if e.Retryable {
			e.Retryable, e.Complete = false, false
			next := make(map[string]Entry, len(s.index))
			for k, v := range s.index {
				next[k] = v
			}
			next[id] = e
			if err := s.save(next); err != nil {
				return Claim{}, err
			}
			s.index = next
			return Claim{Execute: true}, nil
		}
		if !e.Complete {
			return Claim{Interrupted: true}, nil
		}
		b, err := s.objects.Read("reply/" + id)
		if err != nil {
			return Claim{}, err
		}
		return Claim{Reply: b}, nil
	}
	next := make(map[string]Entry, len(s.index)+1)
	for key, e := range s.index {
		if !e.Complete || e.Expires >= now {
			next[key] = e
		}
	}
	if len(next) >= 512 {
		return Claim{}, errors.New("invocation receipt capacity reached")
	}
	next[id] = Entry{Digest: digest, Expires: expires.UnixMilli()}
	// The durable intent is committed before any native program starts.
	if err := s.save(next); err != nil {
		return Claim{}, err
	}
	old := s.index
	s.index = next
	for key := range old {
		if _, ok := next[key]; !ok {
			_ = s.objects.Remove("reply/" + key)
		}
	}
	return Claim{Execute: true}, nil
}
func (s *Store) Complete(id string, reply json.RawMessage) error {
	return s.finish(id, reply, false)
}

// Defer records a response that proves no side effect occurred (for example,
// waiting for local consent). A retry is allowed only for the same digest.
func (s *Store) Defer(id string, reply json.RawMessage) error {
	return s.finish(id, reply, true)
}
func (s *Store) finish(id string, reply json.RawMessage, retryable bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("receipt store closed for handoff")
	}
	e, ok := s.index[id]
	if !ok {
		return errors.New("missing invocation receipt")
	}
	if e.Complete {
		return nil
	}
	if err := s.objects.Write("reply/"+id, reply); err != nil {
		return err
	}
	next := make(map[string]Entry, len(s.index))
	for k, v := range s.index {
		next[k] = v
	}
	e.Complete = true
	e.Retryable = retryable
	next[id] = e
	if err := s.save(next); err != nil {
		return err
	}
	s.index = next
	return nil
}
func (s *Store) EnableEncryption(c *vault.Cipher) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.objects.EnableEncryption(c)
}
func (s *Store) Encrypted() bool { return s.objects.Encrypted() }

// Lookup is read-only and cannot turn an interrupted execution into new work.
func (s *Store) Lookup(id string) (Claim, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.index[id]
	if !ok || e.Complete && e.Expires < time.Now().UnixMilli() {
		return Claim{}, os.ErrNotExist
	}
	if !e.Complete {
		return Claim{Interrupted: true}, nil
	}
	b, err := s.objects.Read("reply/" + id)
	if err != nil {
		return Claim{}, err
	}
	return Claim{Reply: b}, nil
}

func (s *Store) Close() { s.mu.Lock(); s.closed = true; s.mu.Unlock() }
