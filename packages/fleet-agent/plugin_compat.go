package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

// This file is the only compatibility boundary for plugin behavior that
// predates persisted runtime declarations. New plugin behavior must be driven
// by the installed manifest instead of adding another identifier check here.
const legacyACPPluginID = "fleet.acp"

func legacyPluginActions(id string) []string {
	if id != legacyACPPluginID {
		return nil
	}
	return []string{"configure", "profiles", "delegate"}
}

func legacyPluginAllowsMissingArtifact(id string) bool {
	return id == legacyACPPluginID
}

func legacyPluginConsent(req pluginRequest) (string, bool) {
	if req.PluginID != legacyACPPluginID {
		return "", false
	}
	var input struct {
		Command        string `json:"command"`
		CWD            string `json:"cwd"`
		Prompt         string `json:"prompt"`
		PermissionMode string `json:"permission_mode"`
	}
	_ = json.Unmarshal(req.Input, &input)
	switch req.Action {
	case "configure":
		if strings.TrimSpace(input.Command) == "" {
			return "", false
		}
		return fmt.Sprintf("plugin %s configure command: %s", req.PluginID, clip(input.Command, 80)), true
	case "delegate":
		nested := "nested permissions rejected"
		if input.PermissionMode == "allow_once" {
			nested = "nested permissions allow once"
		}
		return fmt.Sprintf("plugin %s delegate in %s (%s): %s", req.PluginID, clip(input.CWD, 60), nested, clip(input.Prompt, 100)), true
	default:
		return "", false
	}
}
