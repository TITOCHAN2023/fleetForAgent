//go:build linux

package hostaudit

import "testing"

func TestLinuxOptInStaysOnStrace(t *testing.T) {
	if !OptIn("linux-strace") || OptIn("darwin-root") || OptIn("windows-root") || OptIn("") {
		t.Fatal("linux opt-in token mismatch")
	}
	cap := CapabilitiesForHost(true)
	if cap.Backend != "linux_strace" || !cap.ProcessLifecycle {
		t.Fatalf("capabilities %#v", cap)
	}
}
