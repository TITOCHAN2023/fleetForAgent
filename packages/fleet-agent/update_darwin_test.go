//go:build darwin

package main

import (
	"archive/zip"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestDarwinUpdateStagesAndVerifiesCompleteSignedApp(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "source", "Fleet Agent.app")
	sourceExe := writeSignedTestAppBundle(t, source, "new-info", "new-resource")
	if out, err := exec.Command("codesign", "--force", "--deep", "--sign", "-", source).CombinedOutput(); err != nil {
		t.Fatalf("sign test app: %v: %s", err, out)
	}
	archive := filepath.Join(dir, "FleetAgent-macos-arm64.zip")
	zipTestApp(t, source, archive)

	live := filepath.Join(dir, "install", "Fleet Agent.app", "Contents", "MacOS", "FleetAgent")
	stagedExe, err := stageUpdateArtifact(archive, live)
	if err != nil {
		t.Fatal(err)
	}
	stagedApp := stagedMacAppPath(filepath.Join(dir, "install", "Fleet Agent.app"))
	if stagedExe != filepath.Join(stagedApp, "Contents", "MacOS", "FleetAgent") {
		t.Fatalf("staged executable=%q", stagedExe)
	}
	info, err := os.ReadFile(filepath.Join(stagedApp, "Contents", "Info.plist"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(info), "<string>new-info</string>") {
		t.Fatalf("staged Info.plist did not come from the new app: %s", info)
	}
	resource, err := os.ReadFile(filepath.Join(stagedApp, "Contents", "Resources", "data.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(resource) != "new-resource" {
		t.Fatalf("staged resource=%q", resource)
	}
	wantSum, err := fileSHA256(sourceExe)
	if err != nil {
		t.Fatal(err)
	}
	gotSum, err := fileSHA256(stagedExe)
	if err != nil {
		t.Fatal(err)
	}
	if gotSum != wantSum {
		t.Fatal("staged executable differs from the signed app executable")
	}
	if _, err := os.Stat(filepath.Join(stagedApp, "Contents", "_CodeSignature", "CodeResources")); err != nil {
		t.Fatalf("signature was not staged with the app: %v", err)
	}
	if err := verifyMacAppBundle(stagedApp); err != nil {
		t.Fatalf("staged app must pass strict code-signature verification: %v", err)
	}
}

func writeSignedTestAppBundle(t *testing.T, app, version, resource string) string {
	t.Helper()
	macOS := filepath.Join(app, "Contents", "MacOS")
	resources := filepath.Join(app, "Contents", "Resources")
	for _, dir := range []string{macOS, resources} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	sourceExe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	destExe := filepath.Join(macOS, "FleetAgent")
	if err := copyFileReplace(sourceExe, destExe); err != nil {
		t.Fatal(err)
	}
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.fleet.agent.tests</string>
<key>CFBundleExecutable</key><string>FleetAgent</string>
<key>CFBundleVersion</key><string>` + version + `</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`
	if err := os.WriteFile(filepath.Join(app, "Contents", "Info.plist"), []byte(plist), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(resources, "data.txt"), []byte(resource), 0o644); err != nil {
		t.Fatal(err)
	}
	return destExe
}

func writeAndSignTestAppBundle(t *testing.T, app, version, resource string) {
	t.Helper()
	writeSignedTestAppBundle(t, app, version, resource)
	if out, err := exec.Command("codesign", "--force", "--deep", "--sign", "-", app).CombinedOutput(); err != nil {
		t.Fatalf("sign %s: %v: %s", app, err, out)
	}
}

func TestDarwinPromoteAndRollbackSwapWholeAppBundles(t *testing.T) {
	dir := t.TempDir()
	liveApp := filepath.Join(dir, "Fleet Agent.app")
	stagedApp := stagedMacAppPath(liveApp)
	if !strings.HasPrefix(filepath.Base(stagedApp), ".") || !strings.HasPrefix(filepath.Base(backupMacAppPath(liveApp)), ".") {
		t.Fatal("staging and long-lived backup app bundles must stay hidden from Finder/LaunchServices")
	}
	writeAndSignTestAppBundle(t, liveApp, "old-version", "old-resource")
	writeAndSignTestAppBundle(t, stagedApp, "new-version", "new-resource")
	liveExe := filepath.Join(liveApp, "Contents", "MacOS", "FleetAgent")
	stagedExe := filepath.Join(stagedApp, "Contents", "MacOS", "FleetAgent")

	if err := promoteUpdateArtifact(stagedExe, liveExe); err != nil {
		t.Fatal(err)
	}
	assertSignedBundleVersion(t, liveApp, "new-version", "new-resource")
	assertSignedBundleVersion(t, backupMacAppPath(liveApp), "old-version", "old-resource")
	if _, err := os.Stat(stagedApp); !os.IsNotExist(err) {
		t.Fatalf("staged app must be consumed by promotion: %v", err)
	}

	rollbackExe, handled, err := rollbackBundledApp(liveExe)
	if err != nil {
		t.Fatal(err)
	}
	if !handled || rollbackExe != liveExe {
		t.Fatalf("handled=%v exe=%q", handled, rollbackExe)
	}
	assertSignedBundleVersion(t, liveApp, "old-version", "old-resource")
	assertSignedBundleVersion(t, backupMacAppPath(liveApp), "new-version", "new-resource")
}

func TestDarwinPromoteFailureRestoresLiveAndPreviousBackup(t *testing.T) {
	dir := t.TempDir()
	liveApp := filepath.Join(dir, "Fleet Agent.app")
	backupApp := backupMacAppPath(liveApp)
	stagedApp := stagedMacAppPath(liveApp)
	writeTestAppBundle(t, liveApp, "live-info", "live-binary", "live-resource")
	writeTestAppBundle(t, backupApp, "backup-info", "backup-binary", "backup-resource")
	writeTestAppBundle(t, stagedApp, "staged-info", "staged-binary", "staged-resource")
	swaps := 0
	failingSecondSwap := func(first, second string) error {
		swaps++
		if swaps == 2 {
			return errors.New("injected second swap failure")
		}
		return atomicSwapMacAppBundles(first, second)
	}

	if err := promoteMacAppBundles(stagedApp, liveApp, failingSecondSwap); err == nil {
		t.Fatal("second atomic swap failure must fail promotion")
	}
	assertBundleVersion(t, liveApp, "live-info", "live-binary", "live-resource")
	assertBundleVersion(t, backupApp, "backup-info", "backup-binary", "backup-resource")
	assertBundleVersion(t, stagedApp, "staged-info", "staged-binary", "staged-resource")
}

func TestDarwinPromotionRetryKeepsOriginalRollbackBundle(t *testing.T) {
	dir := t.TempDir()
	liveApp := filepath.Join(dir, "Fleet Agent.app")
	stagedApp := stagedMacAppPath(liveApp)
	writeAndSignTestAppBundle(t, liveApp, "old-version", "old-resource")
	writeAndSignTestAppBundle(t, stagedApp, "new-version", "new-resource")
	liveExe := filepath.Join(liveApp, "Contents", "MacOS", "FleetAgent")
	stagedExe := filepath.Join(stagedApp, "Contents", "MacOS", "FleetAgent")

	if err := promoteUpdateArtifact(stagedExe, liveExe); err != nil {
		t.Fatal(err)
	}
	assertSignedBundleVersion(t, liveApp, "new-version", "new-resource")
	assertSignedBundleVersion(t, backupMacAppPath(liveApp), "old-version", "old-resource")

	// Simulate a failed restart followed by retrying the same downloaded app.
	if err := copyAppBundleLimited(liveApp, stagedApp, maxExtractedUpdateBytes); err != nil {
		t.Fatal(err)
	}
	if err := promoteUpdateArtifact(stagedExe, liveExe); err != nil {
		t.Fatal(err)
	}
	assertSignedBundleVersion(t, liveApp, "new-version", "new-resource")
	assertSignedBundleVersion(t, backupMacAppPath(liveApp), "old-version", "old-resource")
	if _, err := os.Stat(stagedApp); !os.IsNotExist(err) {
		t.Fatalf("idempotent retry must consume staged duplicate: %v", err)
	}
}

func writeTestAppBundle(t *testing.T, app, info, binary, resource string) {
	t.Helper()
	for _, dir := range []string{
		filepath.Join(app, "Contents", "MacOS"),
		filepath.Join(app, "Contents", "Resources"),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for path, file := range map[string]struct {
		body string
		mode os.FileMode
	}{
		filepath.Join(app, "Contents", "Info.plist"):            {info, 0o644},
		filepath.Join(app, "Contents", "MacOS", "FleetAgent"):   {binary, 0o755},
		filepath.Join(app, "Contents", "Resources", "data.txt"): {resource, 0o644},
	} {
		if err := os.WriteFile(path, []byte(file.body), file.mode); err != nil {
			t.Fatal(err)
		}
	}
}

func zipTestApp(t *testing.T, app, archive string) {
	t.Helper()
	out, err := os.Create(archive)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(out)
	parent := filepath.Dir(app)
	err = filepath.WalkDir(app, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(parent, path)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(rel)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.IsDir() {
			name += "/"
		}
		h, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		h.Name = name
		h.Method = zip.Deflate
		w, err := zw.CreateHeader(h)
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(w, in)
		closeErr := in.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
	if err == nil {
		h := &zip.FileHeader{Name: filepath.Base(app) + "/Contents/._Info.plist", Method: zip.Deflate}
		h.SetMode(0o644)
		var w io.Writer
		w, err = zw.CreateHeader(h)
		if err == nil {
			_, err = io.WriteString(w, "simulated AppleDouble metadata")
		}
	}
	if err == nil {
		err = zw.Close()
	} else {
		_ = zw.Close()
	}
	closeErr := out.Close()
	if err != nil {
		t.Fatal(err)
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}
}

func assertBundleVersion(t *testing.T, app, info, binary, resource string) {
	t.Helper()
	for rel, want := range map[string]string{
		"Contents/Info.plist":         info,
		"Contents/MacOS/FleetAgent":   binary,
		"Contents/Resources/data.txt": resource,
	} {
		got, err := os.ReadFile(filepath.Join(app, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatal(err)
		}
		if strings.TrimSpace(string(got)) != want {
			t.Fatalf("%s %s=%q want %q", app, rel, got, want)
		}
	}
}

func assertSignedBundleVersion(t *testing.T, app, version, resource string) {
	t.Helper()
	if err := verifyMacAppBundle(app); err != nil {
		t.Fatalf("%s signature: %v", app, err)
	}
	info, err := os.ReadFile(filepath.Join(app, "Contents", "Info.plist"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(info), "<string>"+version+"</string>") {
		t.Fatalf("%s version is not %q: %s", app, version, info)
	}
	gotResource, err := os.ReadFile(filepath.Join(app, "Contents", "Resources", "data.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(gotResource) != resource {
		t.Fatalf("%s resource=%q want %q", app, gotResource, resource)
	}
}
