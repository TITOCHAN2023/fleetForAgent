package main

import (
	"os"
	"path/filepath"
	"strings"
)

const defaultSettingsAddr = "127.0.0.1:17890"

// settingsAddr is the local UI/API listen address.
// FLEET_SETTINGS_ADDR overrides it so a test agent can sit beside the stable 17890 instance.
func settingsAddr() string {
	v := strings.TrimSpace(os.Getenv("FLEET_SETTINGS_ADDR"))
	if v == "" {
		return defaultSettingsAddr
	}
	v = strings.TrimPrefix(v, "http://")
	v = strings.TrimPrefix(v, "https://")
	return v
}

// settingsURL follows settingsAddr. Defaults stay http://127.0.0.1:17890 when env is unset.
func settingsURL() string {
	return "http://" + settingsAddr()
}

// fleetHome is the config directory. FLEET_HOME overrides ~/.fleet-agent.
func fleetHome() string {
	if v := strings.TrimSpace(os.Getenv("FLEET_HOME")); v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ".fleet-agent"
	}
	return filepath.Join(home, ".fleet-agent")
}

func configPath() string {
	return filepath.Join(fleetHome(), "config.json")
}
