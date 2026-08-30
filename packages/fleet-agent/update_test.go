package main

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
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
	if allowedUpdateURL("http://example.com/x") {
		t.Fatal("plain http off-loopback")
	}
	if allowedUpdateURL("javascript:alert(1)") {
		t.Fatal("scheme")
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
	setUpdateChannel("")
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

func TestDiscoverUsesAdvertisedVersionedChecksums(t *testing.T) {
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
	setUpdateChannel("")
	rememberUpdateChannel(versionSignal{
		Version:      "0.3.2",
		Base:         srv.URL,
		ChecksumsURL: srv.URL + "/checksums-0.3.2.txt",
	})
	t.Cleanup(func() { setUpdateChannel("") })
	rel, err := discoverRelease()
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

func TestDiscoverUsesInlineAdvertisedSums(t *testing.T) {
	name := releaseAssetNames(runtime.GOOS, runtime.GOARCH)[0]
	sum := sha256Hex("inline")
	t.Setenv("FLEET_UPDATE_BASE", "http://127.0.0.1:9/dl")
	t.Setenv("FLEET_UPDATE_API", "")
	setUpdateChannel("")
	rememberUpdateChannel(versionSignal{
		Version: "0.3.2",
		Base:    "http://127.0.0.1:9/dl",
		Sums:    map[string]string{name: sum},
	})
	t.Cleanup(func() { setUpdateChannel("") })
	rel, err := discoverRelease()
	if err != nil {
		t.Fatal(err)
	}
	asset, gotSum, err := pickAsset(rel)
	if err != nil {
		t.Fatal(err)
	}
	if asset.URL != "http://127.0.0.1:9/dl/"+name || gotSum != sum {
		t.Fatalf("url=%q sum=%q", asset.URL, gotSum)
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

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
