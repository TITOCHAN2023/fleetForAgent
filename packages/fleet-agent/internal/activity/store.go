// Package activity is the device-local, transport-independent audit journal.
package activity

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/TITOCHAN2023/fleetForAgent/internal/filelock"
	"github.com/TITOCHAN2023/fleetForAgent/internal/vault"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const maxRecord = 32 << 10
const segmentBytes = 32 << 20

type Event struct {
	DeviceID string         `json:"device_id,omitempty"`
	Actor    string         `json:"actor,omitempty"`
	Seq      uint64         `json:"seq"`
	Time     int64          `json:"time"`
	Corr     string         `json:"corr,omitempty"`
	PluginID string         `json:"plugin_id,omitempty"`
	Kind     string         `json:"kind"`
	Phase    string         `json:"phase"`
	Source   string         `json:"source"`
	Summary  string         `json:"summary"`
	Details  map[string]any `json:"details,omitempty"`
}

type Query struct {
	After, Before        uint64
	Since, Until         int64
	Limit                int
	Kind, PluginID, Corr string
	Recent               bool
}
type Page struct {
	Events        []Event `json:"events"`
	Next          uint64  `json:"next"`
	First         uint64  `json:"first"`
	HasEarlier    bool    `json:"has_earlier"`
	Oldest        uint64  `json:"oldest"`
	Gap           bool    `json:"gap"`
	RecoveredTail bool    `json:"recovered_tail"`
}
type Store struct {
	cipher       *vault.Cipher
	releaseLock  func()
	mu           sync.Mutex
	path         string
	file         *os.File
	seq          uint64
	oldest       uint64
	currentFirst uint64
	recovered    bool
	failed       error
	exporting    bool
}

var secret = regexp.MustCompile(`(?i)((?:token|password|passwd|secret|api[_-]?key|authorization|cookie|credential)["']?(?:\s*[:=]\s*|\s+))("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\\"(?:\\.|[^"\\])*?\\"|\\'(?:\\.|[^'\\])*?\\'|[^\s"']+)`)
var authorization = regexp.MustCompile(`(?i)(authorization[\s"']*[:=][\s"']*)(?:bearer|basic)\s+[^\s"']+`)
var cookieHeader = regexp.MustCompile(`(?i)(cookie[\s"']*[:=][\s"']*)[^\r\n]+`)
var urlCredential = regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]*://)[^\s/@]+@`)
var fleetCredential = regexp.MustCompile(`flt_1[._-][A-Za-z0-9_.-]+`)

func Redact(s string) string {
	s = authorization.ReplaceAllString(s, `${1}[redacted]`)
	s = cookieHeader.ReplaceAllString(s, `${1}[redacted]`)
	s = secret.ReplaceAllString(s, `${1}[redacted]`)
	s = urlCredential.ReplaceAllString(s, `${1}[redacted]@`)
	return fleetCredential.ReplaceAllString(s, "[redacted]")
}

func Open(dir string) (*Store, error) { return OpenEncrypted(dir, nil) }
func OpenEncrypted(dir string, c *vault.Cipher) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	release, err := filelock.Acquire(filepath.Join(dir, "journal.lock"))
	if err != nil {
		return nil, fmt.Errorf("activity journal requires a single writer: %w", err)
	}
	opened := false
	defer func() {
		if !opened {
			release()
		}
	}()
	s := &Store{path: filepath.Join(dir, "events.jsonl"), releaseLock: release, cipher: c}
	if c == nil {
		for _, name := range []string{"events.enc.jsonl", "events.enc.jsonl.previous", "migration.json"} {
			if _, err := os.Lstat(filepath.Join(dir, name)); err == nil {
				return nil, errors.New("encrypted activity journal requires its key")
			}
		}
	} else {
		if err := prepareEncryptedJournal(dir, c); err != nil {
			return nil, err
		}
		s.path = filepath.Join(dir, "events.enc.jsonl")
	}
	for _, path := range []string{s.path + ".previous", s.path} {
		if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
			return nil, errors.New("activity journal must be a regular file")
		}
		last, valid, tail, err := s.scan(path, func(e Event) error {
			if e.Seq <= s.seq || s.seq > 0 && e.Seq != s.seq+1 {
				return errors.New("activity sequence regressed across segments")
			}
			s.seq = e.Seq
			if s.oldest == 0 {
				s.oldest = e.Seq
			}
			if path == s.path && s.currentFirst == 0 {
				s.currentFirst = e.Seq
			}
			return nil
		})
		_ = last
		if err != nil {
			return nil, err
		}
		if tail {
			if path != s.path {
				return nil, errors.New("incomplete archived activity journal")
			}
			if err := os.Truncate(path, valid); err != nil {
				return nil, err
			}
			s.recovered = true
		}
	}
	f, err := os.OpenFile(s.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	s.file = f
	opened = true
	return s, nil
}

func scan(path string, visit func(Event) error) (uint64, int64, bool, error) {
	return scanDecoded(path, func(b []byte) (Event, error) { return decodeEvent(nil, b) }, visit)
}
func scanDecoded(path string, decode func([]byte) (Event, error), visit func(Event) error) (last uint64, valid int64, tail bool, err error) {
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return 0, 0, false, nil
	}
	if err != nil {
		return 0, 0, false, err
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 64<<10)
	for {
		line, readErr := r.ReadSlice('\n')
		if readErr == io.EOF {
			return last, valid, len(line) > 0, nil
		}
		if readErr != nil {
			return last, valid, false, fmt.Errorf("read activity journal: %w", readErr)
		}
		e, decodeErr := decode(line)
		if decodeErr != nil || e.Seq <= last || last > 0 && e.Seq != last+1 {
			return last, valid, false, errors.New("invalid activity journal record")
		}
		last = e.Seq
		valid += int64(len(line))
		if err := visit(e); err != nil {
			return last, valid, false, err
		}
	}
}

func (s *Store) Append(e Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failed != nil {
		return s.failed
	}
	if s.file == nil {
		return errors.New("activity journal is closed")
	}
	e.Seq = s.seq + 1
	e.Time = time.Now().UnixMilli()
	e.Details = SafeDetails(e.Details)
	e.Summary = Redact(e.Summary)
	if len(e.Summary) > 2048 {
		e.Summary = e.Summary[:2048]
	}
	b, err := encodeEvent(s.cipher, e)
	if err != nil {
		return err
	}
	if len(b)+1 >= 64<<10 {
		return errors.New("activity event too large")
	}
	info, err := s.file.Stat()
	if err != nil {
		return err
	}
	if info.Size()+int64(len(b)+1) > segmentBytes {
		if err := s.file.Close(); err != nil {
			return err
		}
		s.file = nil
		if err := os.Remove(s.path + ".previous"); err != nil && !os.IsNotExist(err) {
			return err
		}
		if err := os.Rename(s.path, s.path+".previous"); err != nil {
			return err
		}
		s.oldest = s.currentFirst
		s.currentFirst = 0
		s.file, err = os.OpenFile(s.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
	}
	n, err := s.file.Write(append(b, '\n'))
	if err == nil && n != len(b)+1 {
		err = io.ErrShortWrite
	}
	if err == nil {
		err = s.file.Sync()
	}
	if err != nil {
		// A partial write or failed fsync has an unknown durable outcome. Do
		// not append another record with the same sequence; restart repairs it.
		s.failed = fmt.Errorf("activity journal requires recovery: %w", err)
		return s.failed
	}
	s.seq = e.Seq
	if s.currentFirst == 0 {
		s.currentFirst = e.Seq
	}
	if s.oldest == 0 {
		s.oldest = e.Seq
	}
	return nil
}

func (s *Store) Read(q Query) (Page, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if q.Limit <= 0 || q.Limit > 500 {
		q.Limit = 200
	}
	p := Page{Events: []Event{}, Next: q.After, Oldest: s.oldest, RecoveredTail: s.recovered}
	p.Gap = s.oldest > 1 && (q.After == 0 || s.oldest > q.After+1)
	if q.After > 0 && q.After >= s.seq {
		return p, nil
	}
	full := errors.New("page full")
	for _, path := range []string{s.path + ".previous", s.path} {
		_, _, _, err := s.scan(path, func(e Event) error {
			if p.Oldest == 0 {
				p.Oldest = e.Seq
			}
			if e.Seq <= q.After {
				return nil
			}
			if q.Before > 0 && e.Seq >= q.Before {
				return nil
			}
			p.Next = e.Seq
			if q.Since > 0 && e.Time < q.Since || q.Until > 0 && e.Time > q.Until {
				return nil
			}
			if q.Kind != "" && e.Kind != q.Kind || q.PluginID != "" && e.PluginID != q.PluginID || q.Corr != "" && e.Corr != q.Corr {
				return nil
			}
			p.Events = append(p.Events, e)
			if len(p.Events) > q.Limit {
				p.Events = p.Events[1:]
				p.HasEarlier = true
			}
			if !q.Recent && q.Before == 0 && len(p.Events) == q.Limit {
				return full
			}
			return nil
		})
		if err == full {
			break
		}
		if err != nil {
			return p, err
		}
	}
	if len(p.Events) > 0 {
		p.First = p.Events[0].Seq
	}
	p.Gap = p.Oldest > 1 && (q.After == 0 || p.Oldest > q.After+1)
	return p, nil
}
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	defer func() {
		if s.releaseLock != nil {
			s.releaseLock()
			s.releaseLock = nil
		}
	}()
	if s.file == nil {
		return nil
	}
	err := s.file.Close()
	s.file = nil
	return err
}

func SafeDetails(m map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range m {
		key := strings.ToLower(k)
		if strings.Contains(key, "token") || strings.Contains(key, "password") || strings.Contains(key, "secret") || strings.Contains(key, "key") || strings.Contains(key, "authorization") || strings.Contains(key, "cookie") || strings.Contains(key, "credential") {
			out[k] = "[redacted]"
			continue
		}
		switch x := v.(type) {
		case string:
			if len(x) > 2048 {
				x = x[:2048]
			}
			out[k] = Redact(x)
		case bool, float64, int, int64, uint64:
			out[k] = x
		}
	}
	return out
}

// ExportSnapshot holds one bounded raw snapshot of the retained window.
// Cipher is immutable (vault.Cipher copies its key and has no mutator).
// Call Close after Export, including writer errors and canceled requests.
var ErrExportBusy = errors.New("activity export already in progress")

// One raw snapshot per process, including storage replacement/handoff.
var activeExport = make(chan struct{}, 1)

type ExportSnapshot struct {
	store    *Store
	once     sync.Once
	cipher   *vault.Cipher
	segments [][]byte
}

func (s *Store) SnapshotForExport(ctx context.Context) (snapshot *ExportSnapshot, err error) {
	select {
	case activeExport <- struct{}{}:
	default:
		return nil, ErrExportBusy
	}
	success := false
	defer func() {
		if !success {
			<-activeExport
		}
	}()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.exporting {
		return nil, ErrExportBusy
	}
	s.exporting = true
	defer func() {
		if !success {
			s.exporting = false
		}
	}()
	snapshot = &ExportSnapshot{store: s, cipher: s.cipher}
	for _, path := range []string{s.path + ".previous", s.path} {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		before, err := os.Lstat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if !before.Mode().IsRegular() || before.Size() > segmentBytes || before.Size() < 0 {
			return nil, errors.New("activity export segment outside retention bound")
		}
		data, err := readExportSegment(path, before)
		if err != nil {
			return nil, err
		}
		snapshot.segments = append(snapshot.segments, data)
	}
	success = true
	return snapshot, nil
}
func readExportSegment(path string, before os.FileInfo) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	after, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || !after.Mode().IsRegular() || !os.SameFile(before, info) || !os.SameFile(info, after) || info.Size() != before.Size() || info.Size() > segmentBytes {
		return nil, errors.New("activity export segment changed")
	}
	data := make([]byte, int(info.Size()))
	_, err = io.ReadFull(f, data)
	return data, err
}
func (snapshot *ExportSnapshot) Close() {
	snapshot.once.Do(func() {
		snapshot.store.mu.Lock()
		snapshot.store.exporting = false
		snapshot.store.mu.Unlock()
		snapshot.segments = nil
		snapshot.cipher = nil
		<-activeExport
	})
}
func (snapshot *ExportSnapshot) Export(ctx context.Context, w io.Writer) error {
	encoder := json.NewEncoder(w)
	last := uint64(0)
	for _, segment := range snapshot.segments {
		reader := bufio.NewReaderSize(bytes.NewReader(segment), 64<<10)
		for {
			if err := ctx.Err(); err != nil {
				return err
			}
			line, err := reader.ReadSlice('\n')
			if err == io.EOF {
				if len(line) != 0 {
					return errors.New("incomplete activity export snapshot")
				}
				break
			}
			if err != nil {
				return err
			}
			event, err := decodeEvent(snapshot.cipher, line)
			if err != nil {
				return err
			}
			if last > 0 && event.Seq != last+1 {
				return errors.New("activity export sequence regressed")
			}
			last = event.Seq
			if err := encoder.Encode(event); err != nil {
				return err
			}
		}
	}
	return nil
}
func (s *Store) Export(ctx context.Context, w io.Writer) error {
	snapshot, err := s.SnapshotForExport(ctx)
	if err != nil {
		return err
	}
	defer snapshot.Close()
	return snapshot.Export(ctx, w)
}
