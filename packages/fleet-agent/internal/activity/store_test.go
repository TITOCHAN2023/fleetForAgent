package activity

import (
	"bytes"
	"encoding/json"
	"github.com/TITOCHAN2023/fleetForAgent/internal/vault"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestJournalSurvivesRestartAndRecoversPartialTail(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ {
		if err = s.Append(Event{Kind: "command", Phase: "requested", Summary: "echo ok"}); err != nil {
			t.Fatal(err)
		}
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(filepath.Join(dir, "events.jsonl"), os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString(`{"seq":5`)
	_ = f.Close()
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.Append(Event{Kind: "command", Phase: "completed"}); err != nil {
		t.Fatal(err)
	}
	page, err := s.Read(Query{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Events) != 5 || page.Next != 5 || !page.RecoveredTail {
		t.Fatalf("bad recovery: %#v", page)
	}
}
func TestJournalConcurrencyFilteringAndRedaction(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				if err := s.Append(Event{Kind: "plugin", PluginID: "example", Summary: "run --password=never-store", Details: map[string]any{"api_key": "never-store"}}); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	wg.Wait()
	page, err := s.Read(Query{PluginID: "example", Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Events) != 50 || page.Next != 50 {
		t.Fatalf("pagination: %#v", page)
	}
	page, err = s.Read(Query{After: page.Next, PluginID: "example", Limit: 50})
	if err != nil || len(page.Events) != 50 || page.Next != 100 {
		t.Fatalf("second page: %#v %v", page, err)
	}
	b, err := os.ReadFile(s.path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "never-store") {
		t.Fatal("credential retained")
	}
}
func TestJournalRejectsCorruptionAndSymlinks(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "events.jsonl"), []byte("garbage\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir); err == nil {
		t.Fatal("corruption accepted")
	}
}

func TestHistoryPaginationAndTimeFilterDoNotDuplicateRecentRecords(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for i := 0; i < 10; i++ {
		if err = s.Append(Event{Kind: "plugin", PluginID: "example"}); err != nil {
			t.Fatal(err)
		}
	}
	page, err := s.Read(Query{Recent: true, Limit: 3, PluginID: "example"})
	if err != nil || page.First != 8 || page.Next != 10 || !page.HasEarlier {
		t.Fatalf("recent: %#v %v", page, err)
	}
	older, err := s.Read(Query{Before: page.First, Limit: 3, PluginID: "example"})
	if err != nil || older.First != 5 || older.Next != 7 || !older.HasEarlier {
		t.Fatalf("older: %#v %v", older, err)
	}
	empty, err := s.Read(Query{Since: page.Events[2].Time + 1})
	if err != nil || len(empty.Events) != 0 || empty.Next != 10 {
		t.Fatalf("time filter: %#v %v", empty, err)
	}
}
func TestJournalRejectsCrossSegmentSequenceRegression(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{"events.jsonl.previous": "{\"seq\":5}\n", "events.jsonl": "{\"seq\":1}\n"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := Open(dir); err == nil {
		t.Fatal("cross-segment corruption accepted")
	}
}

func TestRedactionRemovesCompleteQuotedCredentialsAndAuthorizationHeaders(t *testing.T) {
	for _, s := range []string{
		`curl -H 'Authorization: Bearer never-store' https://example.test`,
		`curl -H "Authorization: Basic never-store" https://example.test`,
		`run --password="never-store with spaces"`,
		`run --token 'never-store with spaces'`,
		`{"authorization":"Bearer never-store with spaces"}`,
		`{"password":"never-store with spaces"}`,
		`https://user:never-store@example.test/path`,
		`Cookie: never-store`,
		`execve("sh", ["-c", "run --password=\"never-store with spaces\""])`,
		`curl -H 'Cookie: value="never-store with spaces"; other=never-store'`,
		`curl -H 'Cookie: first=never-store; second=never-store' https://example.test`,
		`https://never-store@example.test/path`,
	} {
		redacted := Redact(s)
		if strings.Contains(redacted, "never-store") || strings.Contains(redacted, "with spaces") {
			t.Fatalf("credential remains: %s", redacted)
		}
	}
	details := SafeDetails(map[string]any{"authorization": "never-store", "cookie": "never-store", "credential": "never-store"})
	for key, value := range details {
		if value != "[redacted]" {
			t.Fatalf("%s credential retained", key)
		}
	}
}

func TestJournalHasOneWriterAndReleasesOwnershipOnClose(t *testing.T) {
	dir := t.TempDir()
	first, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = Open(dir); err == nil {
		t.Fatal("second journal writer accepted")
	}
	if err = first.Append(Event{Kind: "device"}); err != nil {
		t.Fatal(err)
	}
	if err = first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if err = second.Append(Event{Kind: "device"}); err != nil {
		t.Fatal(err)
	}
	page, err := second.Read(Query{})
	if err != nil || page.Next != 2 || len(page.Events) != 2 {
		t.Fatalf("writer handoff lost sequence: %#v %v", page, err)
	}
}

func TestEncryptedJournalMigrationRestartAndTamperDetection(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ {
		if err = s.Append(Event{Kind: "plugin", Summary: "private fixture data"}); err != nil {
			t.Fatal(err)
		}
	}
	c, _ := vault.New(bytes.Repeat([]byte{42}, 32))
	if err = s.EnableEncryption(c); err != nil {
		t.Fatal(err)
	}
	if err = s.Append(Event{Kind: "plugin", Summary: "private fixture data"}); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(dir, "events.jsonl")); !os.IsNotExist(err) {
		t.Fatal("plaintext journal remained")
	}
	encoded, err := os.ReadFile(filepath.Join(dir, "events.enc.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte("private fixture data")) {
		t.Fatal("event not encrypted")
	}
	if _, err = Open(dir); err == nil {
		t.Fatal("encrypted journal opened without key")
	}
	s, err = OpenEncrypted(dir, c)
	if err != nil {
		t.Fatal(err)
	}
	page, err := s.Read(Query{})
	if err != nil || len(page.Events) != 5 || page.Next != 5 {
		t.Fatal("encrypted restart lost history")
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	var first map[string]any
	lines := bytes.Split(encoded, []byte("\n"))
	json.Unmarshal(lines[0], &first)
	first["seq"] = float64(99)
	lines[0], _ = json.Marshal(first)
	if err = os.WriteFile(filepath.Join(dir, "events.enc.jsonl"), bytes.Join(lines, []byte("\n")), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = OpenEncrypted(dir, c); err == nil {
		t.Fatal("tampered sequence accepted")
	}
}
func TestEncryptedOpenMigratesLegacyAndRefusesWrongKey(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	s.Append(Event{Kind: "command", Summary: "fixture"})
	s.Close()
	c, _ := vault.New(bytes.Repeat([]byte{42}, 32))
	s, err = OpenEncrypted(dir, c)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	wrong, _ := vault.New(bytes.Repeat([]byte{43}, 32))
	if _, err = OpenEncrypted(dir, wrong); err == nil {
		t.Fatal("wrong key opened journal")
	}
}

func TestEncryptedMigrationResumesAfterOneOriginalSegmentWasRemoved(t *testing.T) {
	dir := t.TempDir()
	c, _ := vault.New(bytes.Repeat([]byte{42}, 32))
	previous := []Event{{Seq: 1, Kind: "command"}, {Seq: 2, Kind: "command"}}
	current := []Event{{Seq: 3, Kind: "command"}, {Seq: 4, Kind: "command"}}
	var encoded, plain []byte
	for _, e := range previous {
		b, err := encodeEvent(c, e)
		if err != nil {
			t.Fatal(err)
		}
		encoded = append(encoded, append(b, '\n')...)
	}
	for _, e := range current {
		b, _ := json.Marshal(e)
		plain = append(plain, append(b, '\n')...)
	}
	if err := os.WriteFile(filepath.Join(dir, "events.enc.jsonl.previous"), encoded, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "events.jsonl"), plain, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "migration.json"), []byte(`{"last":4}`), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := OpenEncrypted(dir, c)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	page, err := s.Read(Query{})
	if err != nil || len(page.Events) != 4 || page.Next != 4 {
		t.Fatalf("partial migration lost history: %#v %v", page, err)
	}
	if _, err = os.Stat(filepath.Join(dir, "migration.json")); !os.IsNotExist(err) {
		t.Fatal("migration marker remained")
	}
}
