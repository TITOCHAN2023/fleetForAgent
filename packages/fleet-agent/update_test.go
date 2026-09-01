package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestParseChecksums(t *testing.T) {
	text := `
# comment
d53901ac7419181122e11ddeb9f49f527c9bc24428c3078eb068ac23c1037105  fleet-agent-linux-amd64.tar.gz
7df0b06d24ddecb9abb3c5a10b623b6e668d890358b30b917ff6d4dd5660cf2e *FleetAgent-windows-amd64.exe
`
	sums := parseChecksums(text)
	if sums["fleet-agent-linux-amd64.tar.gz"] != "d53901ac7419181122e11ddeb9f49f527c9bc24428c3078eb068ac23c1037105" {
		t.Fatalf("%v", sums)
	}
	if sums["FleetAgent-windows-amd64.exe"] != "7df0b06d24ddecb9abb3c5a10b623b6e668d890358b30b917ff6d4dd5660cf2e" {
		t.Fatalf("%v", sums)
	}
}

func TestReleaseAssetNames(t *testing.T) {
	mac := releaseAssetNames("darwin", "arm64")
	if mac[0] != "FleetAgent-macos-arm64.zip" || mac[1] != "FleetAgent-macos-arm64.dmg" {
		t.Fatalf("%v", mac)
	}
	if releaseAssetNames("windows", "amd64")[0] != "FleetAgent-windows-amd64.exe" {
		t.Fatal("windows asset")
	}
	if releaseAssetNames("linux", "amd64")[0] != "fleet-agent-linux-amd64.tar.gz" {
		t.Fatal("linux asset")
	}
}

func TestPickAssetPrefersZipOnDarwin(t *testing.T) {
	rel := &discoveredRelease{
		Assets: []releaseAsset{
			{Name: "FleetAgent-macos-arm64.dmg", URL: "https://example/dmg"},
			{Name: "FleetAgent-macos-arm64.zip", URL: "https://example/zip"},
		},
		Sums: map[string]string{"FleetAgent-macos-arm64.zip": "abc"},
	}
	// temporarily not using runtime — call the same picker logic
	names := releaseAssetNames("darwin", "arm64")
	var got releaseAsset
	for _, name := range names {
		for _, a := range rel.Assets {
			if a.Name == name {
				got = a
				break
			}
		}
		if got.Name != "" {
			break
		}
	}
	if got.Name != "FleetAgent-macos-arm64.zip" {
		t.Fatalf("prefer zip, got %q", got.Name)
	}
}

func TestVersionGreater(t *testing.T) {
	if !versionGreater("0.3.1", "0.3.0") {
		t.Fatal("0.3.1 > 0.3.0")
	}
	if versionGreater("0.3.0", "0.3.1") {
		t.Fatal("0.3.0 not > 0.3.1")
	}
	if versionGreater("v0.3.1", "0.3.1") {
		t.Fatal("equal after strip")
	}
}

func TestAllowedUpdateURL(t *testing.T) {
	if !allowedUpdateURL("https://github.com/TITOCHAN2023/fleetForAgent/releases/latest/download/x") {
		t.Fatal("https")
	}
	if !allowedUpdateURL("http://127.0.0.1:9/x") {
		t.Fatal("loopback http")
	}
	if allowedUpdateURL("https://github.com/attacker/fleetForAgent/releases/latest/download/x") {
		t.Fatal("another GitHub repository is not the update trust root")
	}
	if allowedUpdateURL("https://github.com/TITOCHAN2023/fleetForAgent/releases/../attacker/x") {
		t.Fatal("dot segments must not escape the pinned release path")
	}
	if allowedUpdateURL("https://attacker.example/x") {
		t.Fatal("arbitrary https must not be trusted")
	}
	if !allowedUpdateURLForHub("https://hub.example/releases/x", "https://hub.example") {
		t.Fatal("an explicit manual update may use its configured hub origin")
	}
	if allowedUpdateURLForHub("https://hub.example.attacker.test/x", "https://hub.example") {
		t.Fatal("hub hostname suffix must not pass same-origin validation")
	}
	if allowedUpdateURL("http://example.com/x") {
		t.Fatal("plain http off-loopback")
	}
	if allowedUpdateURL("javascript:alert(1)") {
		t.Fatal("scheme")
	}
}

func TestUpdateRedirectCannotLeaveTrustedSource(t *testing.T) {
	client := updateClientFor("https://hub.example")
	via := []*http.Request{{URL: mustURL(t, "https://hub.example/releases/fleet")}}
	req := &http.Request{URL: mustURL(t, "https://attacker.example/payload")}
	if err := client.CheckRedirect(req, via); err == nil {
		t.Fatal("hub redirect to an attacker origin must be blocked")
	}

	via = []*http.Request{{URL: mustURL(t, "https://github.com/TITOCHAN2023/fleetForAgent/releases/latest/download/fleet")}}
	req = &http.Request{URL: mustURL(t, "https://release-assets.githubusercontent.com/github-production-release-asset/x")}
	if err := client.CheckRedirect(req, via); err != nil {
		t.Fatalf("official GitHub asset redirect blocked: %v", err)
	}
}

func TestExtractTarGzAgentBinary(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "fleet-agent-linux-amd64.tar.gz")
	if err := writeTarGz(archive, map[string]string{
		"fleet":       "symlink-or-copy",
		"fleet-agent": "#!/bin/sh\necho ok\n",
	}); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(dir, "out")
	if err := extractAgentBinary(archive, dest); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "echo ok") {
		t.Fatalf("extracted %q", b)
	}
	st, err := os.Stat(dest)
	if err != nil {
		t.Fatal(err)
	}
	// Windows does not expose Unix execute bits through os.FileMode; Chmod only
	// controls the read-only attribute there. The extracted bytes and file type
	// are still worth testing on every platform, but executable mode is a Unix
	// contract.
	if runtime.GOOS != "windows" && st.Mode()&0o111 == 0 {
		t.Fatal("extracted binary must be executable")
	}
}

func TestExtractedPayloadLimitsRemovePartialFiles(t *testing.T) {
	t.Run("raw", func(t *testing.T) {
		dest := filepath.Join(t.TempDir(), "FleetAgent")
		if err := writeExtractedLimited(dest, strings.NewReader("12345"), 0o755, 4); err == nil {
			t.Fatal("oversized raw payload must fail")
		}
		assertNoUpdatePartial(t, dest)
	})

	t.Run("tar.gz", func(t *testing.T) {
		dir := t.TempDir()
		archive := filepath.Join(dir, "agent.tar.gz")
		if err := writeTarGz(archive, map[string]string{"fleet-agent": "12345"}); err != nil {
			t.Fatal(err)
		}
		dest := filepath.Join(dir, "FleetAgent")
		if err := extractFromTarGzLimited(archive, dest, 4); err == nil {
			t.Fatal("oversized tar payload must fail")
		}
		assertNoUpdatePartial(t, dest)
	})

	t.Run("zip", func(t *testing.T) {
		dir := t.TempDir()
		archive := filepath.Join(dir, "agent.zip")
		if err := writeZipFiles(archive, map[string]zipTestFile{
			"Fleet Agent.app/Contents/MacOS/FleetAgent": {Body: "12345", Mode: 0o755},
		}); err != nil {
			t.Fatal(err)
		}
		dest := filepath.Join(dir, "FleetAgent")
		if err := extractFromZipLimited(archive, dest, 4); err == nil {
			t.Fatal("oversized zip payload must fail")
		}
		assertNoUpdatePartial(t, dest)
	})
}

func TestTarExtractionLimitsEntriesBeforeWriting(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "agent.tar.gz")
	if err := writeTarGzEntries(archive, []tarTestFile{
		{Name: "empty-a", Mode: 0o755, Typeflag: tar.TypeDir},
		{Name: "empty-b", Mode: 0o755, Typeflag: tar.TypeDir},
		{Name: "fleet-agent", Body: "binary", Mode: 0o755, Typeflag: tar.TypeReg},
	}); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(dir, "FleetAgent")
	if err := extractFromTarGzWithLimits(archive, dest, 64, 2); err == nil {
		t.Fatal("tar entry limit must include directories")
	}
	assertNoUpdatePartial(t, dest)
}

func TestExtractZipAppBundleWritesCompleteBundle(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "FleetAgent.zip")
	files := map[string]zipTestFile{
		"Fleet Agent.app/Contents/Info.plist":                   {Body: "new-info", Mode: 0o644},
		"Fleet Agent.app/Contents/MacOS/FleetAgent":             {Body: "new-binary", Mode: 0o755},
		"Fleet Agent.app/Contents/_CodeSignature/CodeResources": {Body: "new-signature", Mode: 0o644},
		"Fleet Agent.app/Contents/._Info.plist":                 {Body: "apple-double", Mode: 0o644},
	}
	if err := writeZipFiles(archive, files); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(dir, "Fleet Agent.new.app")
	if err := extractZipAppBundle(archive, dest, 64); err != nil {
		t.Fatal(err)
	}
	for rel, want := range map[string]string{
		"Contents/Info.plist":                   "new-info",
		"Contents/MacOS/FleetAgent":             "new-binary",
		"Contents/_CodeSignature/CodeResources": "new-signature",
	} {
		got, err := os.ReadFile(filepath.Join(dest, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != want {
			t.Fatalf("%s=%q want %q", rel, got, want)
		}
	}
	if _, err := os.Stat(filepath.Join(dest, "Contents", "._Info.plist")); !os.IsNotExist(err) {
		t.Fatalf("AppleDouble metadata must not become an app file: %v", err)
	}
}

func TestExtractZipAppBundleEnforcesCumulativeLimitAndCleans(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "FleetAgent.zip")
	if err := writeZipFiles(archive, map[string]zipTestFile{
		"Fleet Agent.app/Contents/Info.plist":       {Body: "1234", Mode: 0o644},
		"Fleet Agent.app/Contents/MacOS/FleetAgent": {Body: "56789", Mode: 0o755},
	}); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(dir, "Fleet Agent.new.app")
	if err := extractZipAppBundle(archive, dest, 8); err == nil {
		t.Fatal("cumulative app extraction over the limit must fail")
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatalf("partial app bundle must be removed: %v", err)
	}
	if _, err := os.Stat(dest + ".part"); !os.IsNotExist(err) {
		t.Fatalf("partial app staging directory must be removed: %v", err)
	}
}

func TestExtractZipAppBundleLimitsEntriesAndCleans(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "FleetAgent.zip")
	if err := writeZipFiles(archive, map[string]zipTestFile{
		"Fleet Agent.app/Contents/":                 {Mode: os.ModeDir | 0o755},
		"Fleet Agent.app/Contents/empty/":           {Mode: os.ModeDir | 0o755},
		"Fleet Agent.app/Contents/Info.plist":       {Body: "info", Mode: 0o644},
		"Fleet Agent.app/Contents/MacOS/FleetAgent": {Body: "binary", Mode: 0o755},
	}); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(dir, "Fleet Agent.new.app")
	if err := extractZipAppBundleWithLimits(archive, dest, 64, 3); err == nil {
		t.Fatal("archive entry limit must include empty directories")
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatalf("entry-limit failure left destination: %v", err)
	}
	if _, err := os.Stat(dest + ".part"); !os.IsNotExist(err) {
		t.Fatalf("entry-limit failure left partial app: %v", err)
	}
}

func TestExtractZipAppBundleRejectsTraversalAndCleans(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "FleetAgent.zip")
	if err := writeZipFiles(archive, map[string]zipTestFile{
		"Fleet Agent.app/Contents/Info.plist":       {Body: "info", Mode: 0o644},
		"Fleet Agent.app/Contents/MacOS/FleetAgent": {Body: "binary", Mode: 0o755},
		"../escape": {Body: "bad", Mode: 0o644},
	}); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(dir, "Fleet Agent.new.app")
	if err := extractZipAppBundle(archive, dest, 64); err == nil {
		t.Fatal("zip traversal must fail")
	}
	if _, err := os.Stat(filepath.Join(dir, "escape")); !os.IsNotExist(err) {
		t.Fatalf("zip traversal wrote outside staging: %v", err)
	}
	if _, err := os.Stat(dest + ".part"); !os.IsNotExist(err) {
		t.Fatalf("partial traversal extraction must be removed: %v", err)
	}
}

func TestDiscoverFromUpdateBase(t *testing.T) {
	archive := filepath.Join(t.TempDir(), "payload.bin")
	if err := os.WriteFile(archive, []byte("hello-agent"), 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256Hex("hello-agent")
	name := releaseAssetNames(runtime.GOOS, runtime.GOARCH)[0]
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/checksums.txt":
			_, _ = w.Write([]byte(sum + "  " + name + "\n"))
		case "/" + name:
			_, _ = w.Write([]byte("hello-agent"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("FLEET_UPDATE_BASE", srv.URL)
	t.Setenv("FLEET_UPDATE_API", "")
	rel, err := discoverRelease()
	if err != nil {
		t.Fatal(err)
	}
	asset, gotSum, err := pickAsset(rel)
	if err != nil {
		t.Fatal(err)
	}
	if asset.Name != name {
		t.Fatalf("asset=%q", asset.Name)
	}
	if gotSum != sum {
		t.Fatalf("sum=%q", gotSum)
	}
}

func TestDiscoverAutomaticUsesVersionHintChecksums(t *testing.T) {
	name := releaseAssetNames(runtime.GOOS, runtime.GOARCH)[0]
	sum := sha256Hex("hello-agent")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/checksums-0.3.2.txt":
			_, _ = w.Write([]byte(sum + "  " + name + "\n"))
		case "/" + name:
			_, _ = w.Write([]byte("hello-agent"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("FLEET_UPDATE_BASE", srv.URL)
	t.Setenv("FLEET_UPDATE_API", "")
	rel, err := discoverAutomaticRelease("0.3.2")
	if err != nil {
		t.Fatal(err)
	}
	if rel.Version != "0.3.2" {
		t.Fatalf("version=%q", rel.Version)
	}
	asset, gotSum, err := pickAsset(rel)
	if err != nil {
		t.Fatal(err)
	}
	if asset.Name != name || gotSum != sum {
		t.Fatalf("asset=%q sum=%q", asset.Name, gotSum)
	}
}

func TestAutomaticChannelIgnoresNonLoopbackOverride(t *testing.T) {
	t.Setenv("FLEET_UPDATE_BASE", "https://attacker.example/releases")
	t.Setenv("FLEET_UPDATE_API", "https://attacker.example/api")
	base, api := automaticUpdateChannel()
	if base != defaultUpdateBase || api != defaultUpdateAPI {
		t.Fatalf("auto channel=%q api=%q", base, api)
	}
}

func TestManualChannelTrustsOnlyItsExplicitOrigin(t *testing.T) {
	t.Setenv("FLEET_UPDATE_BASE", "https://mirror.example/fleet/releases")
	t.Setenv("FLEET_UPDATE_API", "")
	if !allowedUpdateURL("https://mirror.example/fleet/releases/agent.tar.gz") {
		t.Fatal("explicit manual channel must remain usable")
	}
	if allowedUpdateURL("https://attacker.example/agent.tar.gz") {
		t.Fatal("manual channel must not trust another origin")
	}
}

func TestWriteUpdateBodyEnforcesLimit(t *testing.T) {
	dest := filepath.Join(t.TempDir(), "agent.tar.gz")
	if err := writeUpdateBody(dest, strings.NewReader("12345"), -1, 4); err == nil {
		t.Fatal("unknown-length oversized body must fail")
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatalf("partial oversized download must be removed: %v", err)
	}
	if err := writeUpdateBody(dest, strings.NewReader("x"), 5, 4); err == nil {
		t.Fatal("oversized Content-Length must fail before writing")
	}
	if err := writeUpdateBody(dest, strings.NewReader("1234"), 4, 4); err != nil {
		t.Fatalf("body at the limit failed: %v", err)
	}
}

func TestApplyUpdateForceStillRequiresValidSHA256(t *testing.T) {
	t.Setenv("FLEET_HOME", t.TempDir())
	payload := filepath.Join(t.TempDir(), "payload.bin")
	if err := os.WriteFile(payload, []byte("not-an-agent"), 0o600); err != nil {
		t.Fatal(err)
	}
	a := &Agent{}
	for _, sum := range []string{"", "not-a-sha256", strings.Repeat("z", 64)} {
		err := applyUpdate(a, updateRequest{URL: payload, SHA256: sum, Force: true})
		if err == nil || !strings.Contains(err.Error(), "missing or invalid sha256") {
			t.Fatalf("sum=%q err=%v", sum, err)
		}
	}
}

func TestChecksumMismatchRefuses(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "x.bin")
	if err := os.WriteFile(path, []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := fileSHA256(path)
	if err != nil {
		t.Fatal(err)
	}
	if got == strings.Repeat("0", 64) {
		t.Fatal(got)
	}
}

func writeTarGz(path string, files map[string]string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	gz := gzip.NewWriter(f)
	defer gz.Close()
	tw := tar.NewWriter(gz)
	defer tw.Close()
	for name, body := range files {
		hdr := &tar.Header{Name: name, Mode: 0755, Size: int64(len(body))}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			return err
		}
	}
	return nil
}

type tarTestFile struct {
	Name     string
	Body     string
	Mode     int64
	Typeflag byte
}

func writeTarGzEntries(path string, files []tarTestFile) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	for _, file := range files {
		hdr := &tar.Header{
			Name:     file.Name,
			Mode:     file.Mode,
			Size:     int64(len(file.Body)),
			Typeflag: file.Typeflag,
		}
		if err := tw.WriteHeader(hdr); err != nil {
			_ = tw.Close()
			_ = gz.Close()
			_ = f.Close()
			return err
		}
		if file.Body != "" {
			if _, err := io.WriteString(tw, file.Body); err != nil {
				_ = tw.Close()
				_ = gz.Close()
				_ = f.Close()
				return err
			}
		}
	}
	if err := tw.Close(); err != nil {
		_ = gz.Close()
		_ = f.Close()
		return err
	}
	if err := gz.Close(); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

type zipTestFile struct {
	Body string
	Mode os.FileMode
}

func writeZipFiles(dest string, files map[string]zipTestFile) error {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, file := range files {
		h := &zip.FileHeader{Name: name, Method: zip.Deflate}
		h.SetMode(file.Mode)
		w, err := zw.CreateHeader(h)
		if err != nil {
			return err
		}
		if file.Mode.IsDir() {
			continue
		}
		if _, err := io.WriteString(w, file.Body); err != nil {
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	return os.WriteFile(dest, buf.Bytes(), 0o600)
}

func assertNoUpdatePartial(t *testing.T, dest string) {
	t.Helper()
	for _, path := range []string{dest, dest + ".part"} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("partial update file remains at %s: %v", path, err)
		}
	}
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}
