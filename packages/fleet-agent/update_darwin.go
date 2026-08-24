//go:build darwin

package main

import (
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

func extractFromDMG(archive, dest string) error {
	mount := filepath.Join(os.TempDir(), "fleet-dmg-"+strconv.Itoa(os.Getpid()))
	if err := os.MkdirAll(mount, 0o755); err != nil {
		return err
	}
	defer os.RemoveAll(mount)
	attach := exec.Command("hdiutil", "attach", "-nobrowse", "-readonly", "-mountpoint", mount, archive)
	if out, err := attach.CombinedOutput(); err != nil {
		return fmt.Errorf("hdiutil attach: %s", strings.TrimSpace(string(out)))
	}
	defer exec.Command("hdiutil", "detach", mount, "-quiet", "-force").Run()
	var found string
	_ = filepath.WalkDir(mount, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d == nil || d.IsDir() {
			return nil
		}
		rel := filepath.ToSlash(path)
		if strings.HasSuffix(rel, "Contents/MacOS/FleetAgent") || looksLikeAgentBinary(d.Name()) {
			found = path
			return filepath.SkipAll
		}
		return nil
	})
	if found == "" {
		return fmt.Errorf("update: FleetAgent not found in dmg")
	}
	return copyFileReplace(found, dest)
}

func clearQuarantine(path string) {
	_ = exec.Command("xattr", "-d", "com.apple.quarantine", path).Run()
	_ = exec.Command("xattr", "-cr", path).Run()
}
