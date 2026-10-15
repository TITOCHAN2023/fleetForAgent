//go:build windows

package hostaudit

import (
	"os"
	"os/exec"
	"testing"
)

func TestWindowsRootIdentityLeavesTheCommandAlone(t *testing.T) {
	if !OptIn("windows-root") || OptIn("linux-strace") || OptIn("darwin-root") || OptIn("") {
		t.Fatal("windows opt-in token mismatch")
	}
	cmd := exec.Command("cmd", "/C", "exit 0")
	original := append([]string{}, cmd.Args...)
	got, session, err := Prepare(cmd, "root", "pane-root", DefaultOptions(true), func(Event) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close("test")
	if got != cmd || len(got.Args) != len(original) {
		t.Fatalf("command rewritten: %#v", got.Args)
	}
	self, err := Identity(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if !self.Valid() || self.PID != os.Getpid() || self.BootID == "" || self.StartID == "" || self.BootID == self.StartID {
		t.Fatalf("identity %#v", self)
	}
	if session.Health().Reason != "unprivileged_root_only" {
		t.Fatal(session.Health())
	}
	cap := CapabilitiesForHost(true)
	if cap.Backend != "windows_userspace_root" || cap.State != "opt_in_root_only" || cap.ProcessLifecycle || cap.FilePathOperations || cap.NetworkAttempts || cap.NetworkFlows {
		t.Fatalf("capabilities overclaim: %#v", cap)
	}
}
