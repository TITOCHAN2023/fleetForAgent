package policy

import (
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
)

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

func TestDevicePolicyRestoresLiteralObfuscation(t *testing.T) {
	rm := base64.StdEncoding.EncodeToString([]byte("rm -rf /\n"))
	if rm != "cm0gLXJmIC8K" {
		t.Fatalf("fixture %s", rm)
	}
	hi := base64.StdEncoding.EncodeToString([]byte("echo hi\n"))
	cleanup := base64.StdEncoding.EncodeToString([]byte("rm -rf /tmp/fleet-cleanup\n"))
	curl := base64.StdEncoding.EncodeToString([]byte("curl https://example.com\n"))
	blocked := []string{
		"echo '" + rm + "' | base64 -d | bash",
		"echo '" + rm + "' | base64 --decode | sh",
		"echo -n '" + strings.TrimRight(rm, "=") + "' | base64 -d | bash",
		"printf '%s' '" + strings.TrimRight(base64.StdEncoding.EncodeToString([]byte("rm -rf /")), "=") + "' | base64 -d | bash",
		"printf '%s\\n' '" + rm + "' | base64 -D | zsh",
		"$(echo " + base64.StdEncoding.EncodeToString([]byte("rm -rf /")) + " | base64 -d)",
		"$(echo 'rm -rf /')",
		"`echo 'rm -rf /'`",
		"echo hi; echo '" + rm + "' | base64 -d | bash",
		"sudo echo '" + rm + "' | base64 -d | sudo bash",
		"false || echo '" + rm + "' | base64 -d | bash",
		"echo ok && echo '" + rm + "' | base64 -d | bash",
		`echo '` + rm + `' | base64 -d |& bash`,
		"echo '" + rm + "' | base64 -d | bash # note",
		"bash -c \"$(echo " + base64.StdEncoding.EncodeToString([]byte("rm -rf /")) + " | base64 -d)\"",
		"$(echo 'reboot')",
		"echo '" + rm + "' | base64 -di | bash",
		"echo '" + rm + "' | base64 -id | bash",
		"echo '" + rm + "' | base64 -dw0 | bash",
		"echo '" + rm + "' | base64 -d | bash 2>/dev/null",
		"echo '" + rm + "' | base64 -d | bash --login",
		"echo '" + rm + "' | base64 -d | bash -o pipefail",
		"eval $(echo 'rm -rf /')",
		"eval reboot",
		"echo '" + hi + "' | base64 -d | bash | echo '" + rm + "' | base64 -d | bash",
		"echo '" + hi + "' | true | echo '" + rm + "' | base64 -d | bash",
		"$(echo '" + rm + "' | base64 -d | bash)",
		"echo \"$(echo '" + rm + "' | base64 -d | bash)\"",
		"$(echo '" + base64.StdEncoding.EncodeToString([]byte("echo '"+rm+"' | base64 -d | bash\n")) + "' | base64 -d | bash)",
	}
	for _, cmd := range blocked {
		if !Blocked(cmd) {
			t.Fatalf("should block %q", cmd)
		}
	}
	allowed := []string{
		"echo '" + rm + "'",
		"echo 'rm -rf /'",
		"printf '%s\\n' \"rm -rf /\"",
		"echo '" + rm + "' | base64 -d",
		"echo 'not@@base64' | base64 -d | bash",
		"$(echo 'Y3UK' | base64 -d)rl https://example.com",
		"rm -rf /tmp/fleet-cleanup",
		"$(echo 'rm -rf /tmp/fleet-cleanup')",
		"echo $(echo 'rm -rf /')",
		"echo $(date)",
		"echo '" + curl + "' | base64 -d | bash",
		"echo '" + cleanup + "' | base64 -d | bash",
		"echo hi # $(echo 'rm -rf /')",
		"$(echo 'rm -rf /tmp/fleet-cleanup') # note",
		"echo '" + rm + "' || true",
		"echo $payload | base64 -d | bash",
		"echo $(echo 'up; reboot later')",
		"ls $(echo '/tmp; reboot')",
		"echo \"$(echo 'up; reboot later')\"",
		"eval $(echo 'rm -rf /tmp/fleet-cleanup')",
		"echo '" + rm + "' | base64 -d | bash -lc 'echo hi'",
		"echo '" + hi + "' | base64 -d | bash | echo '" + hi + "' | base64 -d | bash",
		"echo \"$(echo '" + hi + "' | base64 -d | bash)\"",
		"$(echo '" + cleanup + "' | base64 -d | bash)",
	}
	for _, cmd := range allowed {
		if Blocked(cmd) {
			t.Fatalf("should allow %q", cmd)
		}
	}
	got, ok := Unfolded("$(echo 'Y3UK' | base64 -d)rl https://example.com")
	if !ok || got != "curl https://example.com" {
		t.Fatalf("unfolded %q ok=%v", got, ok)
	}
	got, ok = Unfolded("echo '" + rm + "' | base64 -d | bash")
	if !ok || got != "rm -rf /" {
		t.Fatalf("unfolded pipe %q ok=%v", got, ok)
	}
	got, ok = Unfolded("$(echo 'rm -rf /')")
	if !ok || got != "rm -rf /" {
		t.Fatalf("unfolded subst %q ok=%v", got, ok)
	}
	got, ok = Unfolded("$(echo '" + rm + "' | base64 -d | bash)")
	if !ok || got != "rm -rf /" {
		t.Fatalf("unfolded inner bash %q ok=%v", got, ok)
	}
	wrapped := "rm -rf /"
	for i := 0; i < 4; i++ {
		wrapped = fmt.Sprintf("echo '%s' | base64 -d | bash", base64.StdEncoding.EncodeToString([]byte(wrapped+"\n")))
	}
	if !Blocked(wrapped) {
		t.Fatal("four-deep rm should be visible and refused")
	}
	safe := "echo hi"
	for i := 0; i < 4; i++ {
		safe = fmt.Sprintf("echo '%s' | base64 -d | bash", base64.StdEncoding.EncodeToString([]byte(safe+"\n")))
	}
	if Blocked(safe) {
		t.Fatal("four-deep echo hi should stay allowed")
	}
	hidden := "echo hi"
	for i := 0; i < restorePeels+1; i++ {
		hidden = fmt.Sprintf("echo '%s' | base64 -d | bash", base64.StdEncoding.EncodeToString([]byte(hidden+"\n")))
	}
	if !Blocked(hidden) {
		t.Fatal("a pipe still encoded past the restore cap should be refused")
	}
}
