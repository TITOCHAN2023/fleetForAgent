//go:build windows

package hostaudit

import (
	"os/exec"
	"strconv"

	"golang.org/x/sys/windows"
)

// windows-root records the process this agent launched. It needs no ETW
// session and no kernel driver. It does not put the process in a Job: os/exec
// cannot pass PROC_THREAD_ATTRIBUTE_JOB_LIST, and assigning a job after
// CreateProcess leaves the breakaway race the sandbox path already refuses.
func OptIn(value string) bool { return value == "windows-root" }

func CapabilitiesForHost(enabled bool) Capabilities {
	state := "not_enabled"
	if enabled {
		state = "opt_in_root_only"
	}
	return Capabilities{Backend: "windows_userspace_root", State: state, Scope: "launcher_root_without_etw"}
}

func prepare(cmd *exec.Cmd, corr, paneID string, _ Options, sink Sink) (*exec.Cmd, Session, error) {
	return cmd, gap(corr, paneID, "unprivileged_root_only", sink), nil
}

func Identity(pid int) (ProcessIdentity, error) {
	p := ProcessIdentity{PID: pid}
	if pid <= 0 {
		return p, identityError(pid)
	}
	boot, err := processCreationFiletime(4)
	if err != nil {
		return p, err
	}
	start, err := processCreationFiletime(uint32(pid))
	if err != nil {
		return p, err
	}
	p.BootID = strconv.FormatInt(boot, 10)
	p.StartID = strconv.FormatInt(start, 10)
	return p, nil
}

func processCreationFiletime(pid uint32) (int64, error) {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(handle)
	var creation, exit, kernel, user windows.Filetime
	if err = windows.GetProcessTimes(handle, &creation, &exit, &kernel, &user); err != nil {
		return 0, err
	}
	ticks := (&creation).Nanoseconds()
	if ticks <= 0 {
		return 0, identityError(int(pid))
	}
	return ticks, nil
}
