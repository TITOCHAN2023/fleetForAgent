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

	"golang.org/x/sys/unix"
)

const macExecutableSuffix = "/Contents/MacOS/FleetAgent"

func extractFromDMG(archive, dest string) error {
	mount, detach, err := mountUpdateDMG(archive)
	if err != nil {
		return err
	}
	defer detach()
	found, err := findAgentExecutable(mount)
	if err != nil {
		return err
	}
	return copyFileReplaceLimited(found, dest, maxExtractedUpdateBytes)
}

func extractAppFromDMG(archive, destApp string) error {
	mount, detach, err := mountUpdateDMG(archive)
	if err != nil {
		return err
	}
	defer detach()
	found, err := findAgentExecutable(mount)
	if err != nil {
		return err
	}
	app, ok := macAppBundleRoot(found)
	if !ok {
		return fmt.Errorf("update: FleetAgent is not inside an app bundle")
	}
	return copyAppBundleLimited(app, destApp, maxExtractedUpdateBytes)
}

func mountUpdateDMG(archive string) (string, func(), error) {
	mount := filepath.Join(os.TempDir(), "fleet-dmg-"+strconv.Itoa(os.Getpid()))
	if err := os.MkdirAll(mount, 0o755); err != nil {
		return "", nil, err
	}
	attach := exec.Command("hdiutil", "attach", "-nobrowse", "-readonly", "-mountpoint", mount, archive)
	if out, err := attach.CombinedOutput(); err != nil {
		_ = os.RemoveAll(mount)
		return "", nil, fmt.Errorf("hdiutil attach: %s", strings.TrimSpace(string(out)))
	}
	return mount, func() {
		_ = exec.Command("hdiutil", "detach", mount, "-quiet", "-force").Run()
		_ = os.RemoveAll(mount)
	}, nil
}

func findAgentExecutable(root string) (string, error) {
	var found string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
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
	if err != nil {
		return "", err
	}
	if found == "" {
		return "", fmt.Errorf("update: FleetAgent not found in dmg")
	}
	return found, nil
}

func stageUpdateArtifact(archive, live string) (string, error) {
	liveApp, bundled := macAppBundleRoot(live)
	if !bundled {
		staged := stagedBinaryPath(live)
		if err := extractAgentBinary(archive, staged); err != nil {
			return "", err
		}
		if err := os.Chmod(staged, 0o755); err != nil {
			return "", err
		}
		clearQuarantine(staged)
		return staged, nil
	}

	stagedApp := stagedMacAppPath(liveApp)
	lower := strings.ToLower(archive)
	var err error
	switch {
	case strings.HasSuffix(lower, ".zip"):
		err = extractZipAppBundle(archive, stagedApp, maxExtractedUpdateBytes)
	case strings.HasSuffix(lower, ".dmg"):
		err = extractAppFromDMG(archive, stagedApp)
	default:
		return "", fmt.Errorf("update: macOS app updates require a complete .zip or .dmg bundle")
	}
	if err != nil {
		return "", err
	}
	stagedExe := filepath.Join(stagedApp, "Contents", "MacOS", "FleetAgent")
	if err := os.Chmod(stagedExe, 0o755); err != nil {
		_ = removeAppBundlePath(stagedApp)
		return "", err
	}
	clearQuarantine(stagedApp)
	if err := verifyMacAppBundle(stagedApp); err != nil {
		_ = removeAppBundlePath(stagedApp)
		return "", err
	}
	return stagedExe, nil
}

func updateNeedsAtomicBundlePromotion(live string) bool {
	_, ok := macAppBundleRoot(live)
	return ok
}

func promoteUpdateArtifact(staged, live string) error {
	liveApp, liveBundled := macAppBundleRoot(live)
	stagedApp, stagedBundled := macAppBundleRoot(staged)
	if !liveBundled {
		return promoteUnix(staged, live)
	}
	if !stagedBundled || stagedApp != stagedMacAppPath(liveApp) {
		return fmt.Errorf("update: staged app bundle does not match live app")
	}
	return promoteMacAppBundles(stagedApp, liveApp, atomicSwapMacAppBundles)
}

type macAppBundleSwap func(string, string) error

func promoteMacAppBundles(stagedApp, liveApp string, swap macAppBundleSwap) error {
	if sameMacAppBundle(stagedApp, liveApp) {
		return removeAppBundlePath(stagedApp)
	}
	backup := backupMacAppPath(liveApp)
	backupInfo, backupErr := os.Stat(backup)
	hadBackup := backupErr == nil
	if backupErr != nil && !os.IsNotExist(backupErr) {
		return backupErr
	}
	if hadBackup && !backupInfo.IsDir() {
		return fmt.Errorf("update: backup is not an app bundle at %s", backup)
	}

	// macOS renameatx_np(RENAME_SWAP) exchanges two sibling directories in one
	// filesystem transaction. The live app path therefore never disappears.
	if err := swap(liveApp, stagedApp); err != nil {
		return fmt.Errorf("update: atomically install app bundle: %w", err)
	}
	if hadBackup {
		// stagedApp now contains the immediately previous live bundle. Swap it
		// with the older backup so backup always remains present. If this fails,
		// swap live/staged back; the pre-existing backup was never touched.
		if err := swap(stagedApp, backup); err != nil {
			if restoreErr := swap(liveApp, stagedApp); restoreErr != nil {
				return fmt.Errorf("update: rotate app backup: %v (restore failed: %v)", err, restoreErr)
			}
			return fmt.Errorf("update: rotate app backup: %w", err)
		}
		return removeAppBundlePath(stagedApp)
	}
	if err := os.Rename(stagedApp, backup); err != nil {
		if restoreErr := swap(liveApp, stagedApp); restoreErr != nil {
			return fmt.Errorf("update: create app backup: %v (restore failed: %v)", err, restoreErr)
		}
		return fmt.Errorf("update: create app backup: %w", err)
	}
	return nil
}

func atomicSwapMacAppBundles(first, second string) error {
	return unix.RenameatxNp(unix.AT_FDCWD, first, unix.AT_FDCWD, second, unix.RENAME_SWAP)
}

func rollbackBundledApp(live string) (string, bool, error) {
	liveApp, ok := macAppBundleRoot(live)
	if !ok {
		return "", false, nil
	}
	backup := backupMacAppPath(liveApp)
	if info, err := os.Stat(backup); err != nil {
		return "", true, fmt.Errorf("no backup at %s", backup)
	} else if !info.IsDir() {
		return "", true, fmt.Errorf("backup is not an app bundle at %s", backup)
	}
	if err := verifyMacAppBundle(backup); err != nil {
		return "", true, err
	}
	if err := atomicSwapMacAppBundles(liveApp, backup); err != nil {
		return "", true, fmt.Errorf("rollback: atomically swap app and backup: %w", err)
	}
	return filepath.Join(liveApp, "Contents", "MacOS", "FleetAgent"), true, nil
}

func macAppBundleRoot(executable string) (string, bool) {
	clean := filepath.ToSlash(filepath.Clean(executable))
	if !strings.HasSuffix(clean, macExecutableSuffix) {
		return "", false
	}
	app := strings.TrimSuffix(clean, macExecutableSuffix)
	if !strings.HasSuffix(app, ".app") || !filepath.IsAbs(filepath.FromSlash(app)) {
		return "", false
	}
	return filepath.FromSlash(app), true
}

func stagedMacAppPath(liveApp string) string {
	return hiddenMacAppSibling(liveApp, "fleet-new")
}

func backupMacAppPath(liveApp string) string {
	return hiddenMacAppSibling(liveApp, "fleet-backup")
}

func hiddenMacAppSibling(liveApp, role string) string {
	name := strings.TrimSuffix(filepath.Base(liveApp), ".app")
	return filepath.Join(filepath.Dir(liveApp), "."+name+"."+role+".app")
}

func verifyMacAppBundle(app string) error {
	if err := validateAppBundle(app); err != nil {
		return err
	}
	cmd := exec.Command("codesign", "--verify", "--deep", "--strict", app)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("update: invalid app signature: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func sameMacAppBundle(first, second string) bool {
	for _, rel := range []string{
		"Contents/Info.plist",
		"Contents/MacOS/FleetAgent",
		"Contents/_CodeSignature/CodeResources",
	} {
		firstSum, err := fileSHA256(filepath.Join(first, filepath.FromSlash(rel)))
		if err != nil {
			return false
		}
		secondSum, err := fileSHA256(filepath.Join(second, filepath.FromSlash(rel)))
		if err != nil || secondSum != firstSum {
			return false
		}
	}
	return true
}

func copyAppBundleLimited(srcApp, destApp string, maxBytes int64) error {
	if !safeAppBundlePath(srcApp) || !safeAppBundlePath(destApp) {
		return fmt.Errorf("update: unsafe app bundle path")
	}
	part := destApp + ".part"
	if err := removeAppBundlePath(part); err != nil {
		return err
	}
	if err := removeAppBundlePath(destApp); err != nil {
		return err
	}
	if err := os.MkdirAll(part, 0o755); err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = removeAppBundlePath(part)
		}
	}()
	budget, err := newExtractionBudget(maxBytes)
	if err != nil {
		return err
	}
	entries := 0
	err = filepath.WalkDir(srcApp, func(src string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		entries++
		if entries > maxUpdateArchiveEntries {
			return fmt.Errorf("update: app bundle exceeds %d entries", maxUpdateArchiveEntries)
		}
		rel, err := filepath.Rel(srcApp, src)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		dest := filepath.Join(part, rel)
		if !pathWithin(part, dest) {
			return fmt.Errorf("update: app path escapes bundle")
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return os.MkdirAll(dest, directoryMode(info.Mode()))
		}
		if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(src)
			if err != nil {
				return err
			}
			if !safeBundleSymlink(part, dest, target) {
				return fmt.Errorf("update: unsafe app symlink %q", rel)
			}
			if int64(len(target)) > budget.remaining {
				return fmt.Errorf("update: extracted payload exceeds %d bytes", maxBytes)
			}
			budget.remaining -= int64(len(target))
			return os.Symlink(target, dest)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("update: unsupported app file %q", rel)
		}
		if info.Size() > budget.remaining {
			return fmt.Errorf("update: extracted payload exceeds %d bytes", maxBytes)
		}
		in, err := os.Open(src)
		if err != nil {
			return err
		}
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
		if err != nil {
			_ = in.Close()
			return err
		}
		copyErr := budget.copy(out, in)
		closeOutErr := out.Close()
		closeInErr := in.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeOutErr != nil {
			return closeOutErr
		}
		return closeInErr
	})
	if err != nil {
		return err
	}
	if err := validateAppBundle(part); err != nil {
		return err
	}
	if err := os.Rename(part, destApp); err != nil {
		return err
	}
	committed = true
	return nil
}

func clearQuarantine(path string) {
	_ = exec.Command("xattr", "-dr", "com.apple.quarantine", path).Run()
}
