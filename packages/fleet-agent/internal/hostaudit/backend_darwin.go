//go:build darwin

package hostaudit

import (
	"os/exec"
	"strconv"

	"golang.org/x/sys/unix"
)

// darwin-root records the process this agent launched. It needs no Developer
// ID certificate, Endpoint Security entitlement, or Network Extension.
// Descendants that leave the process group, file syscalls, and network flows
// stay invisible; those require the signed helpers this opt-in does not claim.
func OptIn(value string) bool { return value == "darwin-root" }

func CapabilitiesForHost(enabled bool) Capabilities {
	state := "not_enabled"
	if enabled {
		state = "opt_in_root_only"
	}
	return Capabilities{Backend: "darwin_userspace_root", State: state, Scope: "launcher_root_without_endpoint_security"}
}

func prepare(cmd *exec.Cmd, corr, paneID string, _ Options, sink Sink) (*exec.Cmd, Session, error) {
	return cmd, gap(corr, paneID, "unprivileged_root_only", sink), nil
}

func Identity(pid int) (ProcessIdentity, error) {
	p := ProcessIdentity{PID: pid}
	if pid <= 0 {
		return p, identityError(pid)
	}
	boot, err := unix.SysctlTimeval("kern.boottime")
	if err != nil || boot.Sec <= 0 {
		return p, identityError(pid)
	}
	info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil || info.Proc.P_starttime.Sec <= 0 {
		return p, identityError(pid)
	}
	p.BootID = strconv.FormatInt(boot.Sec, 10)
	p.StartID = strconv.FormatInt(info.Proc.P_starttime.Sec, 10) + "." + strconv.FormatInt(int64(info.Proc.P_starttime.Usec), 10)
	return p, nil
}
