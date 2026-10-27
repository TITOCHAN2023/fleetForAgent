//go:build linux

package hostaudit

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestTraceMetadataDoesNotDecodePayloadOrArgv(t *testing.T) {
	p := newTraceParser()
	for _, line := range []string{`999999 1792007000.1 execve(0x1, 0x2, 0x3) = 0`, `999999 1792007000.2 read(0x0, 0xabc, 0x40) = 0x10`, `999999 1792007000.3 connect(3, {sa_family=AF_INET, sin_port=htons(80), sin_addr=inet_addr("127.0.0.1")}, 16) = -1 ECONNREFUSED (Connection refused)`} {
		events, e := p.parse(line)
		if e != nil || len(events) != 1 {
			t.Fatal(events, e)
		}
		raw, _ := json.Marshal(events[0])
		if strings.Contains(string(raw), "argv") {
			t.Fatal("argv exposed")
		}
	}
}
func TestTraceUnfinishedAndUnknownRecordsReportLoss(t *testing.T) {
	p := newTraceParser()
	if _, e := p.parse(`999999 1792007000.1 openat(AT_FDCWD, "/tmp/a", O_RDONLY <unfinished ...>`); e != nil {
		t.Fatal(e)
	}
	events, e := p.parse(`999999 1792007000.2 <... openat resumed>) = 3`)
	if e != nil || len(events) != 1 || events[0].Kind != "file_path_operation" {
		t.Fatal(events, e)
	}
	if _, e := p.parse(`999999 1792007000.3 <... read resumed>) = 3`); e == nil {
		t.Fatal("missing loss error")
	}
	if _, e := p.parse(`999999 1792007000.3 fork() = `); e == nil {
		t.Fatal("missing syscall result accepted")
	}
	if _, e := p.parse(`unrecognized diagnostic`); e == nil {
		t.Fatal("unknown record silently accepted")
	}
}
func TestTracePathTruncationAndIdentityGapAreExplicit(t *testing.T) {
	p := newTraceParser()
	events, e := p.parse(`999999 1792007000.1 openat(AT_FDCWD, "/tmp/long"..., O_RDONLY) = 3`)
	if e != nil || len(events) != 1 || events[0].Details["path_truncated"] != true || events[0].Details["process_identity_gap"] != true {
		t.Fatal(events, e)
	}
}
func TestUnboundHistoricalPIDCannotClaimCurrentLiveIdentity(t *testing.T) {
	p := newTraceParser()
	pid := os.Getpid()
	events, err := p.parse(fmt.Sprintf(`%d 1000.1 openat(AT_FDCWD, "/tmp/historical", O_RDONLY) = 3`, pid))
	if err != nil || len(events) != 1 {
		t.Fatal(events, err)
	}
	if events[0].Process.Valid() || events[0].Process.StartID != "" || events[0].Details["process_identity_gap"] != true {
		t.Fatal("current live process assigned to historical event", events[0])
	}
	if _, err := p.parse(fmt.Sprintf(`%d 1000.2 futex(0x1, FUTEX_WAIT_PRIVATE, 2, NULL) = 0`, pid)); err == nil {
		t.Fatal("unknown syscall was mislabeled a file operation")
	}
}
