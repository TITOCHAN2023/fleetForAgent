package receipts

import (
	"bytes"
	"encoding/json"
	"github.com/TITOCHAN2023/fleetForAgent/internal/vault"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRestartReplaysCompleteAndRefusesUnknownExecution(t *testing.T) {
	dir := t.TempDir()
	c, _ := vault.New(bytes.Repeat([]byte{42}, 32))
	s, err := Open(dir, c)
	if err != nil {
		t.Fatal(err)
	}
	digest := strings.Repeat("a", 64)
	q, err := s.Claim("done", digest, time.Now().Add(time.Hour))
	if err != nil || !q.Execute {
		t.Fatal(err)
	}
	if err = s.Complete("done", json.RawMessage(`{"secret_result":"private result"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Claim("pending", digest, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(dir, c)
	if err != nil {
		t.Fatal(err)
	}
	q, err = reopened.Claim("done", digest, time.Now().Add(time.Hour))
	if err != nil || q.Execute || !bytes.Contains(q.Reply, []byte("private result")) {
		t.Fatal("completed execution was not replayed")
	}
	q, err = reopened.Claim("pending", digest, time.Now().Add(time.Hour))
	if err != nil || q.Execute || !q.Interrupted {
		t.Fatal("unknown execution was rerun")
	}
	if _, err = reopened.Claim("done", strings.Repeat("b", 64), time.Now().Add(time.Hour)); err == nil {
		t.Fatal("caller/input mismatch accepted")
	}
	files, _ := os.ReadDir(dir)
	for _, f := range files {
		b, _ := os.ReadFile(filepath.Join(dir, f.Name()))
		if bytes.Contains(b, []byte("private result")) {
			t.Fatal("result stored in plaintext")
		}
	}
}

func TestUnknownIntentDoesNotExpireIntoAutomaticExecution(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	digest := strings.Repeat("a", 64)
	if _, err = s.Claim("unknown", digest, time.Now().Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	q, err := s.Claim("unknown", digest, time.Now().Add(time.Hour))
	if err != nil || q.Execute || !q.Interrupted {
		t.Fatal("expired unknown intent executed again")
	}
	if _, err = s.Claim("new", digest, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	q, err = s.Lookup("unknown")
	if err != nil || !q.Interrupted {
		t.Fatal("pruning discarded unknown intent")
	}
}

func TestConsentIntentCanRetryAfterRestartButStillBindsInput(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	digest := strings.Repeat("a", 64)
	if _, err = s.Claim("consent", digest, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err = s.Defer("consent", json.RawMessage(`{"status":"consent"}`)); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Claim("consent", strings.Repeat("b", 64), time.Now().Add(time.Hour)); err == nil {
		t.Fatal("consent input changed")
	}
	q, err := s.Claim("consent", digest, time.Now().Add(time.Hour))
	if err != nil || !q.Execute {
		t.Fatal("consent receipt blocked valid retry")
	}
	q, err = s.Claim("consent", digest, time.Now().Add(time.Hour))
	if err != nil || q.Execute || !q.Interrupted {
		t.Fatal("retry intent was not saved before execution")
	}
}
