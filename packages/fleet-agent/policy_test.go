package main

import "testing"

func TestDevicePolicyBlocksDangerousRmRf(t *testing.T) {
	blocked := []string{
		"rm -rf /",
		"rm -rf /*",
		"rm -rf ~",
		"rm -rf ~/",
		"rm -rf $HOME",
		"rm -rf *",
		"rm -rf .",
		"rm -rf ..",
		"rm -rf /tmp",
		"rm -rf",
		"sudo rm -rf /",
		"echo hi; rm -rf /",
		"rm -rf /tmp/foo /",
		"shutdown now",
		"reboot",
	}
	for _, cmd := range blocked {
		if !devicePolicyBlocked(cmd) {
			t.Fatalf("should block %q", cmd)
		}
	}
}

func TestDevicePolicyAllowsAbsoluteCleanupRmRf(t *testing.T) {
	allowed := []string{
		`rm -rf /tmp/fleet-cleanup`,
		`rm -rf /home/user/project/build`,
		`rm -rf -- /var/tmp/agent-scratch`,
		`rm -r -f /tmp/fleet-cleanup`,
		`rm -fr /opt/app/.cache`,
		`echo 'rm -rf /'`,
		`printf '%s\n' "rm -rf /"`,
	}
	for _, cmd := range allowed {
		if devicePolicyBlocked(cmd) {
			t.Fatalf("should allow %q", cmd)
		}
	}
}

func TestStripProbeSequences(t *testing.T) {
	in := "\x1b]11;?\x07\x1b[6nhello"
	got := stripProbeSequences(in)
	if got != "hello" {
		t.Fatalf("got %q", got)
	}
	bare := "]11;?[6nworld"
	if stripProbeSequences(bare) != "world" {
		t.Fatalf("bare probes: %q", stripProbeSequences(bare))
	}
	if stripRunOutput("\x1b]11;?\x1b\\\x1b[6nkeep\n") != "keep\n" {
		t.Fatalf("stripRunOutput: %q", stripRunOutput("\x1b]11;?\x1b\\\x1b[6nkeep\n"))
	}
}
