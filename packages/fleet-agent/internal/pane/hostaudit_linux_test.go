//go:build linux

package pane

import (
	"encoding/json"
	"fmt"
	"github.com/TITOCHAN2023/fleetForAgent/internal/hostaudit"
	"golang.org/x/sys/unix"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

type observations struct {
	mu     sync.Mutex
	events []hostaudit.Event
}

func (o *observations) add(e hostaudit.Event) error {
	o.mu.Lock()
	o.events = append(o.events, e)
	o.mu.Unlock()
	return nil
}
func (o *observations) has(kind, phase string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	for _, e := range o.events {
		if e.Kind == kind && e.Phase == phase {
			return true
		}
	}
	return false
}
func (o *observations) snapshot() []hostaudit.Event {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]hostaudit.Event{}, o.events...)
}
func awaitHost(t *testing.T, p *Pane, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if done, code := p.Finished(); done {
			if code != want {
				stdout, stderr := p.ResultText()
				t.Fatalf("exit=%d want=%d out=%s err=%s", code, want, stdout, stderr)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("root completion blocked")
}
func hostProof(t *testing.T) {
	if os.Getenv("FLEET_HOST_AUDIT_PROOF") != "1" {
		t.Skip("isolated Linux real host probe only")
	}
}
func observed(t *testing.T, command string, opts hostaudit.Options) (*Pane, *observations) {
	t.Helper()
	o := &observations{}
	p, e := NewSupervisor().SpawnForObserved("", t.Name(), command, opts, o.add)
	if e != nil {
		t.Fatal(e)
	}
	deadline := time.Now().Add(300 * time.Millisecond)
	for !o.has("coverage", "active") && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !o.has("coverage", "active") {
		t.Fatalf("backend not active: %+v", o.snapshot())
	}
	t.Cleanup(func() { p.AuditSession().Close("test_end") })
	return p, o
}
func TestHostAuditRealPTYMetadata(t *testing.T) {
	hostProof(t)
	p, o := observed(t, `test -t 0 && test -t 1 && test -t 2 || exit 19; printf 'ready\n'; read value; printf 'answer:%s cwd:%s env:%s\n' "$value" "$PWD" "$TERM"; exit 17`, hostaudit.DefaultOptions(true))
	time.Sleep(100 * time.Millisecond)
	if e := p.TypeInput("sensitive-proof-input\n", ""); e != nil {
		t.Fatal(e)
	}
	awaitHost(t, p, 17)
	out, _ := p.ResultText()
	if !strings.Contains(out, "answer:sensitive-proof-input") {
		t.Fatalf("PTY IO changed: %q", out)
	}
	b, _ := json.Marshal(o.snapshot())
	if strings.Contains(string(b), "sensitive-proof-input") {
		t.Fatal("payload in audit")
	}
	t.Logf("PTY output preserved; %d metadata events", len(o.snapshot()))
}
func TestHostAuditRealCtrlC(t *testing.T) {
	hostProof(t)
	p, _ := observed(t, `sleep 10`, hostaudit.DefaultOptions(true))
	time.Sleep(100 * time.Millisecond)
	if e := p.TypeInput("", "ctrl+c"); e != nil {
		t.Fatal(e)
	}
	awaitHost(t, p, -1)
}
func TestHostAuditRealDetachedDescendants(t *testing.T) {
	hostProof(t)
	for _, mode := range []string{"nohup", "setsid", "doublefork"} {
		t.Run(mode, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "after-root")
			ready := file + ".ready"
			script := `printf ready > ` + shellQuote(ready) + `; sleep .9; printf ok > ` + shellQuote(file)
			cmd := ""
			switch mode {
			case "nohup":
				cmd = "nohup sh -c " + shellQuote(script) + " >/dev/null 2>&1 & while [ ! -f " + shellQuote(ready) + " ]; do sleep .01; done; exit 9"
			case "setsid":
				cmd = "setsid sh -c " + shellQuote(script) + " >/dev/null 2>&1 & while [ ! -f " + shellQuote(ready) + " ]; do sleep .01; done; exit 9"
			case "doublefork":
				cmd = "nohup sh -c " + shellQuote("sh -c "+shellQuote(script)+" >/dev/null 2>&1 & exit 0") + " >/dev/null 2>&1 & while [ ! -f " + shellQuote(ready) + " ]; do sleep .01; done; exit 9"
			}
			start := time.Now()
			p, o := observed(t, cmd, hostaudit.DefaultOptions(true))
			awaitHost(t, p, 9)
			if time.Since(start) > 700*time.Millisecond {
				t.Fatal("completion waited for descendants")
			}
			rootDuration := time.Since(start)
			deadline := time.Now().Add(3 * time.Second)
			for time.Now().Before(deadline) {
				if b, _ := os.ReadFile(file); string(b) == "ok" {
					break
				}
				time.Sleep(20 * time.Millisecond)
			}
			if b, e := os.ReadFile(file); e != nil || string(b) != "ok" {
				t.Fatal("background work lost", e)
			}
			time.Sleep(120 * time.Millisecond)
			found := false
			for _, event := range o.snapshot() {
				if event.Kind == "file_path_operation" && strings.Contains(fmtDetails(event.Details), file) && event.Details["root_completed"] == true {
					found = true
				}
			}
			if !found {
				t.Fatalf("post-root metadata missing: %+v", o.snapshot())
			}
			t.Logf("root completed in %s; descendant persisted and audited", rootDuration)
		})
	}
}
func shellQuote(s string) string         { return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'" }
func fmtDetails(m map[string]any) string { b, _ := json.Marshal(m); return string(b) }
func TestHostAuditRealCollectorStopKeepsWork(t *testing.T) {
	hostProof(t)
	for _, method := range []string{"close", "kill", "limit", "lease"} {
		t.Run(method, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "continued")
			opts := hostaudit.DefaultOptions(true)
			if method == "limit" {
				opts.MaxEvents = 250
			}
			if method == "lease" {
				opts.Lease = 150 * time.Millisecond
			}
			p, o := observed(t, `sleep .3; printf ok > `+shellQuote(file)+`; exit 13`, opts)
			switch method {
			case "close":
				p.AuditSession().Close("local_disable")
			case "kill":
				for _, e := range o.snapshot() {
					if id, ok := e.Details["tracer_pid"].(int); ok {
						if err := syscall.Kill(id, syscall.SIGKILL); err != nil {
							t.Fatal(err)
						}
					}
				}
			}
			awaitHost(t, p, 13)
			if b, e := os.ReadFile(file); e != nil || string(b) != "ok" {
				t.Fatal("collector affected workload", e)
			}
			t.Logf("%s preserves business exit/file", method)
		})
	}
}
func TestHostAuditRealShortRoots(t *testing.T) {
	hostProof(t)
	for i := 0; i < 8; i++ {
		p, o := observed(t, `exit 21`, hostaudit.DefaultOptions(true))
		awaitHost(t, p, 21)
		if !o.has("process", "root_bound") {
			t.Fatal("binding lost")
		}
		p.AuditSession().Close("probe_end")
	}
}

// This is a measured compatibility boundary, not a claimed all-pass guarantee.
// A shell can exit before its child installs nohup/setsid; ptrace changes timing.
func TestHostAuditRealImmediateBackgroundComparison(t *testing.T) {
	hostProof(t)
	for _, mode := range []string{"nohup", "setsid", "doublefork"} {
		for _, enabled := range []bool{false, true} {
			missing := 0
			for i := 0; i < 4; i++ {
				file := filepath.Join(t.TempDir(), "effect")
				script := `sleep .04; printf ok > ` + shellQuote(file)
				cmd := mode + " sh -c " + shellQuote(script) + " >/dev/null 2>&1 & exit 0"
				if mode == "doublefork" {
					cmd = "nohup sh -c " + shellQuote("sh -c "+shellQuote(script)+" >/dev/null 2>&1 & exit 0") + " >/dev/null 2>&1 & exit 0"
				}
				o := &observations{}
				p, e := NewSupervisor().SpawnForObserved("", "comparison", cmd, hostaudit.DefaultOptions(enabled), o.add)
				if e != nil {
					t.Fatal(e)
				}
				awaitHost(t, p, 0)
				deadline := time.Now().Add(160 * time.Millisecond)
				for time.Now().Before(deadline) {
					if b, _ := os.ReadFile(file); string(b) == "ok" {
						break
					}
					time.Sleep(10 * time.Millisecond)
				}
				if b, _ := os.ReadFile(file); string(b) != "ok" {
					missing++
				}
				p.AuditSession().Close("comparison_end")
			}
			t.Logf("mode=%s experimental_strace=%v immediate-background missing=%d/4", mode, enabled, missing)
		}
	}
}
func TestHostAuditRealPermissionGapSingleExecution(t *testing.T) {
	hostProof(t)
	if os.Getenv("FLEET_HOST_AUDIT_DENY_PTRACE") == "1" {
		filter := []unix.SockFilter{{Code: unix.BPF_LD | unix.BPF_W | unix.BPF_ABS, K: 0}, {Code: unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K, K: uint32(unix.SYS_PTRACE), Jf: 1}, {Code: unix.BPF_RET | unix.BPF_K, K: unix.SECCOMP_RET_ERRNO | uint32(unix.EPERM)}, {Code: unix.BPF_RET | unix.BPF_K, K: unix.SECCOMP_RET_ALLOW}}
		prog := unix.SockFprog{Len: uint16(len(filter)), Filter: &filter[0]}
		if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
			t.Fatal(err)
		}
		if err := unix.Prctl(unix.PR_SET_SECCOMP, unix.SECCOMP_MODE_FILTER, uintptr(unsafe.Pointer(&prog)), 0, 0); err != nil {
			t.Fatal(err)
		}
		file := filepath.Join(t.TempDir(), "effect")
		o := &observations{}
		p, err := NewSupervisor().SpawnForObserved("", "deny", `printf x >> `+shellQuote(file), hostaudit.DefaultOptions(true), o.add)
		if err != nil {
			t.Fatal(err)
		}
		awaitHost(t, p, 0)
		if b, _ := os.ReadFile(file); string(b) != "x" {
			t.Fatal("missing or repeated workload")
		}
		if !o.has("coverage", "gap") || o.has("coverage", "active") {
			t.Fatal("permission failure not explicit", o.snapshot())
		}
		t.Log("kernel seccomp ptrace EPERM: gap; workload ran once")
		return
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestHostAuditRealPermissionGapSingleExecution$", "-test.v")
	cmd.Env = append(os.Environ(), "FLEET_HOST_AUDIT_DENY_PTRACE=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("permission probe: %s %v", out, err)
	}
	t.Log(string(out))
}
func TestHostAuditRealJournalFailureDetaches(t *testing.T) {
	hostProof(t)
	file := filepath.Join(t.TempDir(), "effect")
	o := &observations{}
	count := 0
	var mu sync.Mutex
	sink := func(e hostaudit.Event) error {
		o.add(e)
		mu.Lock()
		count++
		n := count
		mu.Unlock()
		if n > 20 {
			return fmt.Errorf("simulated locked journal")
		}
		return nil
	}
	p, err := NewSupervisor().SpawnForObserved("", "journal", `sleep .3; printf ok > `+shellQuote(file)+`; exit 16`, hostaudit.DefaultOptions(true), sink)
	if err != nil {
		t.Fatal(err)
	}
	awaitHost(t, p, 16)
	if b, _ := os.ReadFile(file); string(b) != "ok" {
		t.Fatal("journal failure affected workload")
	}
	found := false
	for _, e := range o.snapshot() {
		if e.Reason == "journal_unavailable" {
			found = true
		}
	}
	if !found {
		t.Fatal("missing journal gap")
	}
	t.Log("failing journal sink attempted gap and detached; workload persisted")
}
func TestHostAuditRealBlockedSinkCannotPauseWorkload(t *testing.T) {
	hostProof(t)
	for _, method := range []string{"close", "lease", "overflow"} {
		t.Run(method, func(t *testing.T) {
			entered := make(chan struct{})
			release := make(chan struct{})
			var once sync.Once
			o := &observations{}
			file := filepath.Join(t.TempDir(), "effect")
			guard := file + ".guard"
			sink := func(e hostaudit.Event) error {
				if e.Kind == "file_path_operation" && strings.Contains(fmtDetails(e.Details), guard) {
					once.Do(func() { close(entered); <-release })
				}
				return o.add(e)
			}
			opts := hostaudit.DefaultOptions(true)
			if method == "lease" {
				opts.Lease = 100 * time.Millisecond
			}
			p, err := NewSupervisor().SpawnForObserved("", method, `printf guard > `+shellQuote(guard)+`; sleep .3; i=0; while [ "$i" -lt 5000 ]; do printf x > /dev/null; i=$((i+1)); done; printf ok > `+shellQuote(file)+`; exit 18`, opts, sink)
			if err != nil {
				close(release)
				t.Fatal(err)
			}
			defer close(release)
			select {
			case <-entered:
			case <-time.After(time.Second):
				t.Fatal("sink not blocked")
			}
			if method == "close" {
				returned := make(chan struct{})
				go func() { p.AuditSession().Close("blocked_sink_stop"); close(returned) }()
				select {
				case <-returned:
				case <-time.After(200 * time.Millisecond):
					t.Fatal("Close waited for blocked sink")
				}
			}
			select {
			case <-p.AuditSession().Done():
			case <-time.After(time.Second):
				t.Fatal("collection lifetime waited for sink")
			}
			deadlineDetach := time.Now().Add(300 * time.Millisecond)
			detached := false
			for time.Now().Before(deadlineDetach) {
				status, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", p.ProcessPID()))
				if os.IsNotExist(err) {
					detached = true
					break
				}
				for _, line := range strings.Split(string(status), "\n") {
					if strings.TrimSpace(line) == "TracerPid:\t0" || strings.Fields(line) != nil && len(strings.Fields(line)) == 2 && strings.Fields(line)[0] == "TracerPid:" && strings.Fields(line)[1] == "0" {
						detached = true
					}
				}
				if detached {
					break
				}
				time.Sleep(time.Millisecond)
			}
			if !detached {
				t.Fatal("verified tracer signal did not detach from workload")
			}
			health := p.AuditSession().Health()
			wantReason := map[string]string{"close": "blocked_sink_stop", "lease": "lease_expired", "overflow": "metadata_queue_full_lost"}[method]
			if health.Reason != wantReason {
				t.Fatalf("wrong stopping mechanism: got %s want %s", health.Reason, wantReason)
			}
			if health.State != "stopped_gap" || health.Persistence != "unknown" {
				t.Fatal("missing independent health", health)
			}
			awaitHost(t, p, 18)
			if b, _ := os.ReadFile(file); string(b) != "ok" {
				t.Fatal("high-syscall workload stalled")
			}
			t.Logf("%s: blocked journal retained; 5000 file writes completed; health=%+v", method, health)
		})
	}
}
func TestHostAuditRealVeryShortLeaseKeepsStoppedState(t *testing.T) {
	hostProof(t)
	for i := 0; i < 4; i++ {
		o := &observations{}
		opts := hostaudit.DefaultOptions(true)
		opts.Lease = time.Nanosecond
		p, err := NewSupervisor().SpawnForObserved("", "short-lease", `exit 24`, opts, o.add)
		if err != nil {
			t.Fatal(err)
		}
		awaitHost(t, p, 24)
		select {
		case <-p.AuditSession().Done():
		case <-time.After(time.Second):
			t.Fatal("short lease not stopped")
		}
		if state := p.AuditSession().Health().State; state != "stopped_gap" {
			t.Fatal("lease/Bind reset stopped state", state)
		}
	}
}
