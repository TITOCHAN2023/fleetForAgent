//go:build !darwin

package main

import "fmt"

func extractFromDMG(archive, dest string) error {
	return fmt.Errorf("update: dmg install is macOS-only (got %s)", archive)
}

func clearQuarantine(string) {}
