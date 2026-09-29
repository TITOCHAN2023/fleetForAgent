//go:build windows

package backend

func herdrAvailable() bool           { return false }
func probeHerdrSession(string) Probe { return ProbeMissing }
func killHerdrSession(string)        {}
func startHerdr(string, SpawnOpts, bool) (*Handle, error) {
	return nil, &GateError{Type: TypeHerdr, Reason: "Fleet Herdr attachment requires a POSIX PTY"}
}
