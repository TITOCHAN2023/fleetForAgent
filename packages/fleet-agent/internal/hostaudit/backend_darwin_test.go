//go:build darwin

package hostaudit

import (
	"os"
	"os/exec"
	"testing"
)

func TestDarwinRootIdentityDoesNotRewriteTheCommand(t *testing.T) {
	if !OptIn("darwin-root") || OptIn("linux-strace") || OptIn("windows-root") || OptIn("") {
		t.Fatal("darwin opt-in token mismatch")
	}
	cmd := exec.Command("/bin/sleep", "30")
	original := append([]string{}, cmd.Args...)
	got, session, err := Prepare(cmd, "root", "pane-root", DefaultOptions(true), func(Event) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close("test")
	if got != cmd || got.Path != "/bin/sleep" || len(got.Args) != len(original) {
		t.Fatalf("command rewritten: %#v", got.Args)
	}
	for i := range original {
		if got.Args[i] != original[i] {
			t.Fatalf("arg %d changed: %q", i, got.Args[i])
		}
	}
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}()
	session.Bind(cmd.Process.Pid)
	root := session.RootIdentity()
	self, err := Identity(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if !root.Valid() || !self.Valid() || root.BootID != self.BootID || root.StartID == self.StartID || root.PID != cmd.Process.Pid {
		t.Fatalf("root %#v self %#v", root, self)
	}
	if session.Health().Reason != "unprivileged_root_only" {
		t.Fatal(session.Health())
	}
	cap := CapabilitiesForHost(true)
	if cap.Backend != "darwin_userspace_root" || cap.State != "opt_in_root_only" || cap.ProcessLifecycle || cap.FilePathOperations || cap.NetworkAttempts || cap.NetworkFlows {
		t.Fatalf("capabilities overclaim: %#v", cap)
	}
}
