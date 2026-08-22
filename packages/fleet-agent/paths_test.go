package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDefaultListenAndHomeWhenEnvEmpty(t *testing.T) {
	t.Setenv("FLEET_HOME", "")
	t.Setenv("FLEET_SETTINGS_ADDR", "")
	if got := settingsAddr(); got != "127.0.0.1:17890" {
		t.Fatalf("settingsAddr=%q", got)
	}
	if got := settingsURL(); got != "http://127.0.0.1:17890" {
		t.Fatalf("settingsURL=%q", got)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(home, ".fleet-agent")
	if got := fleetHome(); got != want {
		t.Fatalf("fleetHome=%q want %q", got, want)
	}
	if got := configPath(); got != filepath.Join(want, "config.json") {
		t.Fatalf("configPath=%q", got)
	}
}

func TestListenAndHomeFollowEnv(t *testing.T) {
	home := filepath.Join(t.TempDir(), "fleet-test-home")
	t.Setenv("FLEET_HOME", home)
	t.Setenv("FLEET_SETTINGS_ADDR", "127.0.0.1:17901")
	if got := settingsAddr(); got != "127.0.0.1:17901" {
		t.Fatalf("settingsAddr=%q", got)
	}
	if got := settingsURL(); got != "http://127.0.0.1:17901" {
		t.Fatalf("settingsURL=%q", got)
	}
	if got := fleetHome(); got != home {
		t.Fatalf("fleetHome=%q want %q", got, home)
	}
	if got := configPath(); got != filepath.Join(home, "config.json") {
		t.Fatalf("configPath=%q", got)
	}
}
