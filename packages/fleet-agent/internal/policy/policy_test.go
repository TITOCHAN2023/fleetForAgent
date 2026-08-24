package policy

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
		if !Blocked(cmd) {
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
		if Blocked(cmd) {
			t.Fatalf("should allow %q", cmd)
		}
	}
}
