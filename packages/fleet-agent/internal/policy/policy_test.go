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
		"sudo -n -u root rm -rf /",
		"/usr/bin/sudo -u root rm -rf /",
		"/bin/rm -rf /",
		"command rm -rf /",
		"command -- rm -rf /",
		"env LC_ALL=C rm -rf /",
		"env -u HOME rm -rf /",
		"busybox rm -rf /",
		"sh -c 'rm -rf /'",
		"bash --noprofile -c 'rm -rf /'",
		"bash -lc '/bin/rm -rf /'",
		"echo hi; rm -rf /",
		"rm -rf /tmp/foo /",
		`rm -rf C:\`,
		`rm -rf C:\tmp\..`,
		`cmd.exe /c "rd /s /q C:\"`,
		`cmd.exe /d /s /c "rd /s /q C:\"`,
		`powershell.exe -Command "Remove-Item C:\ -Recurse -Force"`,
		`powershell.exe -NoProfile -Command "Remove-Item C:\ -Recurse -Force"`,
		`powershell.exe -EncodedCommand ZgBvAG8A`,
		`C:\Windows\System32\shutdown.exe /s`,
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
		`echo shutdown`,
		`rm -rf C:\Users\fleet\AppData\Local\Temp\fleet-cleanup`,
	}
	for _, cmd := range allowed {
		if Blocked(cmd) {
			t.Fatalf("should allow %q", cmd)
		}
	}
}
