//go:build !darwin

package main

import (
	"fmt"
	"os"
)

func extractFromDMG(archive, dest string) error {
	return fmt.Errorf("update: dmg install is macOS-only (got %s)", archive)
}

func clearQuarantine(string) {}

func stageUpdateArtifact(archive, live string) (string, error) {
	staged := stagedBinaryPath(live)
	if err := extractAgentBinary(archive, staged); err != nil {
		return "", err
	}
	if err := os.Chmod(staged, 0o755); err != nil {
		return "", err
	}
	return staged, nil
}

func updateNeedsAtomicBundlePromotion(string) bool { return false }

func promoteUpdateArtifact(staged, live string) error {
	return promoteUnix(staged, live)
}

func rollbackBundledApp(string) (string, bool, error) {
	return "", false, nil
}
