package main

import (
	"os"
	"strings"
	"testing"
)

func TestHelpContainsVersion(t *testing.T) {
	text := helpText()
	if !strings.HasPrefix(text, "Fleet Agent "+agentVersion+" —") {
		t.Fatalf("help first line should include version %s:\n%s", agentVersion, text)
	}
	if !strings.Contains(text, agentVersion) {
		t.Fatalf("help missing version %s", agentVersion)
	}
	if agentVersion != "0.2.4" {
		t.Fatalf("agentVersion=%s want 0.2.4", agentVersion)
	}
}

func TestDeviceNameFollowsFleetName(t *testing.T) {
	t.Setenv("FLEET_NAME", "test-box")
	if got := deviceName(); got != "test-box" {
		t.Fatalf("deviceName=%q", got)
	}
	t.Setenv("FLEET_NAME", "")
	if got := deviceName(); got == "test-box" {
		t.Fatalf("empty FLEET_NAME should fall back to hostname, got %q", got)
	}
	if os.Getenv("FLEET_NAME") != "" {
		t.Fatal("env leaked")
	}
}
