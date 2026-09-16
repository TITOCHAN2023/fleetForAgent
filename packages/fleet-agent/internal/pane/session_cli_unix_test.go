//go:build linux || darwin || freebsd || netbsd || openbsd

package pane

import (
	"strings"
	"testing"
)

func TestSessionClosePTYRefusesUnsupportedOperation(t *testing.T) {
	t.Setenv("FLEET_BACKEND_TYPE", "pty")
	err := SessionCLI([]string{"close", "test"})
	if err == nil || !strings.Contains(err.Error(), "does not support closing sessions by name") {
		t.Fatalf("expected explicit unsupported-operation error, got %v", err)
	}
}
