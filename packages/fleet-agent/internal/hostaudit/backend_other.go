//go:build !linux && !darwin && !windows

package hostaudit

import "os/exec"

func OptIn(string) bool { return false }
func prepare(cmd *exec.Cmd, corr, paneID string, _ Options, sink Sink) (*exec.Cmd, Session, error) {
	return unavailable(cmd, corr, paneID, sink)
}
func Identity(pid int) (ProcessIdentity, error) { return ProcessIdentity{PID: pid}, identityError(pid) }
func CapabilitiesForHost(enabled bool) Capabilities {
	state := "backend_unavailable"
	if !enabled {
		state = "not_enabled"
	}
	return Capabilities{Backend: "unavailable", State: state, Scope: "ordinary_host"}
}
