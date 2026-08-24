package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	defaultUpdateRepo = "TITOCHAN2023/fleetForAgent"
	defaultUpdateBase = "https://github.com/" + defaultUpdateRepo + "/releases/latest/download"
	defaultUpdateAPI  = "https://api.github.com/repos/" + defaultUpdateRepo + "/releases/latest"
)

type updateRequest struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Force  bool   `json:"force"`
	Check  bool   `json:"check"`
}

type updateInfo struct {
	Current   string `json:"current"`
	Latest    string `json:"latest,omitempty"`
	Available bool   `json:"available"`
	Armed     bool   `json:"armed"`
	Asset     string `json:"asset,omitempty"`
	AssetURL  string `json:"assetUrl,omitempty"`
	SHA256    string `json:"sha256,omitempty"`
	Staged    string `json:"staged,omitempty"`
	Phase     string `json:"phase"`
	Error     string `json:"error,omitempty"`
}

type releaseAsset struct {
	Name string
	URL  string
}

type discoveredRelease struct {
	Version string
	Assets  []releaseAsset
	Sums    map[string]string
}

var (
	updateMu     sync.Mutex
	updateSnap   = updateInfo{Current: agentVersion, Phase: "idle"}
	updateHTTP   = &http.Client{Timeout: 2 * time.Minute}
	updateRunner sync.Mutex
)

func updateStatus() updateInfo {
	updateMu.Lock()
	defer updateMu.Unlock()
	out := updateSnap
	out.Current = agentVersion
	return out
}

func setUpdateStatus(mut func(*updateInfo)) {
	updateMu.Lock()
	defer updateMu.Unlock()
	mut(&updateSnap)
	updateSnap.Current = agentVersion
}

func updateBase() string {
	if v := strings.TrimSpace(os.Getenv("FLEET_UPDATE_BASE")); v != "" {
		return strings.TrimRight(v, "/")
	}
	if v := advertisedUpdateBase(); v != "" {
		return v
	}
	return defaultUpdateBase
}

func updateAPI() string {
	if v, ok := os.LookupEnv("FLEET_UPDATE_API"); ok {
		return strings.TrimSpace(v)
	}
	if strings.TrimSpace(os.Getenv("FLEET_UPDATE_BASE")) != "" || advertisedUpdateBase() != "" {
		return ""
	}
	return defaultUpdateAPI
}

func releaseAssetNames(goos, arch string) []string {
	switch goos {
	case "darwin":
		return []string{
			"FleetAgent-macos-" + arch + ".zip",
			"FleetAgent-macos-" + arch + ".dmg",
		}
	case "windows":
		return []string{"FleetAgent-windows-" + arch + ".exe"}
	default:
		return []string{"fleet-agent-linux-" + arch + ".tar.gz"}
	}
}

func parseChecksums(text string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		sum := strings.ToLower(fields[0])
		if len(sum) != 64 {
			continue
		}
		name := fields[1]
		name = strings.TrimPrefix(name, "*")
		name = filepath.Base(name)
		out[name] = sum
	}
	return out
}

func checksumFor(sums map[string]string, name string) string {
	if sums == nil {
		return ""
	}
	if s := sums[name]; s != "" {
		return s
	}
	return sums[filepath.Base(name)]
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func versionGreater(latest, current string) bool {
	l := parseVer(latest)
	c := parseVer(current)
	for i := 0; i < 3; i++ {
		if l[i] > c[i] {
			return true
		}
		if l[i] < c[i] {
			return false
		}
	}
	return false
}

func parseVer(s string) [3]int {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "v")
	s = strings.TrimPrefix(s, "V")
	var out [3]int
	parts := strings.Split(s, ".")
	for i := 0; i < 3 && i < len(parts); i++ {
		n := 0
		for _, r := range parts[i] {
			if r < '0' || r > '9' {
				break
			}
			n = n*10 + int(r-'0')
		}
		out[i] = n
	}
	return out
}

func allowedUpdateURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return false
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
		return true
	case "http":
		host := u.Hostname()
		if strings.EqualFold(host, "localhost") {
			return true
		}
		ip := net.ParseIP(host)
		return ip != nil && ip.IsLoopback()
	default:
		return false
	}
}

func allowedLocalUpdatePath(raw string) string {
	if raw == "" {
		return ""
	}
	if strings.Contains(raw, "://") {
		u, err := url.Parse(raw)
		if err != nil || u.Scheme != "file" {
			return ""
		}
		return u.Path
	}
	if filepath.IsAbs(raw) {
		return raw
	}
	return ""
}

func fetchBytes(raw string) ([]byte, error) {
	if !allowedUpdateURL(raw) {
		return nil, fmt.Errorf("update: blocked url")
	}
	req, err := http.NewRequest(http.MethodGet, raw, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Fleet-Agent/"+agentVersion)
	req.Header.Set("Accept", "application/octet-stream, text/plain, application/json")
	res, err := updateHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return nil, fmt.Errorf("update: http %s", res.Status)
	}
	return io.ReadAll(io.LimitReader(res.Body, 8<<20))
}

func downloadTo(raw, dest string) error {
	if !allowedUpdateURL(raw) {
		return fmt.Errorf("update: blocked url")
	}
	req, err := http.NewRequest(http.MethodGet, raw, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Fleet-Agent/"+agentVersion)
	res, err := updateHTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("update: http %s", res.Status)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(f, res.Body)
	closeErr := f.Close()
	if copyErr != nil {
		_ = os.Remove(dest)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(dest)
		return closeErr
	}
	return nil
}

func discoverRelease() (*discoveredRelease, error) {
	rel := &discoveredRelease{Sums: map[string]string{}}
	if api := updateAPI(); api != "" {
		if err := fillReleaseFromAPI(rel, api); err != nil && strings.TrimSpace(os.Getenv("FLEET_UPDATE_BASE")) == "" {
			// still try constructed latest/download URLs below
		}
	}
	base := updateBase()
	if len(rel.Assets) == 0 && base != "" {
		for _, name := range releaseAssetNames(runtime.GOOS, runtime.GOARCH) {
			rel.Assets = append(rel.Assets, releaseAsset{Name: name, URL: base + "/" + name})
		}
	}
	if len(rel.Sums) == 0 {
		rel.Sums = fetchChecksums(rel, base)
	}
	if len(rel.Assets) == 0 {
		return nil, fmt.Errorf("update: no assets for %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	return rel, nil
}

func fillReleaseFromAPI(rel *discoveredRelease, api string) error {
	b, err := fetchBytes(api)
	if err != nil {
		return err
	}
	var payload struct {
		TagName string `json:"tag_name"`
		Name    string `json:"name"`
		Assets  []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(b, &payload); err != nil {
		return err
	}
	rel.Version = strings.TrimPrefix(strings.TrimSpace(payload.TagName), "v")
	if rel.Version == "" {
		rel.Version = strings.TrimSpace(payload.Name)
	}
	want := map[string]bool{}
	for _, n := range releaseAssetNames(runtime.GOOS, runtime.GOARCH) {
		want[n] = true
	}
	var sums []releaseAsset
	for _, a := range payload.Assets {
		if want[a.Name] {
			rel.Assets = append(rel.Assets, releaseAsset{Name: a.Name, URL: a.URL})
		}
		if strings.HasPrefix(a.Name, "checksums") && strings.HasSuffix(a.Name, ".txt") {
			sums = append(sums, releaseAsset{Name: a.Name, URL: a.URL})
		}
	}
	for _, s := range sums {
		if b, err := fetchBytes(s.URL); err == nil {
			for k, v := range parseChecksums(string(b)) {
				rel.Sums[k] = v
			}
		}
	}
	return nil
}

func fetchChecksums(rel *discoveredRelease, base string) map[string]string {
	out := map[string]string{}
	candidates := []string{}
	if base != "" {
		candidates = append(candidates, base+"/checksums.txt")
		if rel.Version != "" {
			candidates = append(candidates, base+"/checksums-"+rel.Version+".txt")
		}
	}
	seen := map[string]bool{}
	for _, u := range candidates {
		if seen[u] {
			continue
		}
		seen[u] = true
		b, err := fetchBytes(u)
		if err != nil {
			continue
		}
		for k, v := range parseChecksums(string(b)) {
			out[k] = v
		}
	}
	return out
}

func pickAsset(rel *discoveredRelease) (releaseAsset, string, error) {
	if rel == nil {
		return releaseAsset{}, "", fmt.Errorf("update: no release")
	}
	for _, name := range releaseAssetNames(runtime.GOOS, runtime.GOARCH) {
		for _, a := range rel.Assets {
			if a.Name == name && a.URL != "" {
				return a, checksumFor(rel.Sums, name), nil
			}
		}
	}
	return releaseAsset{}, "", fmt.Errorf("update: no %s/%s asset on this channel", runtime.GOOS, runtime.GOARCH)
}

func checkUpdate() (updateInfo, error) {
	rel, err := discoverRelease()
	info := updateInfo{Current: agentVersion, Phase: "idle"}
	if err != nil {
		info.Phase = "error"
		info.Error = err.Error()
		setUpdateStatus(func(s *updateInfo) { *s = info })
		return info, err
	}
	info.Latest = rel.Version
	asset, sum, err := pickAsset(rel)
	if err != nil {
		info.Phase = "error"
		info.Error = err.Error()
		setUpdateStatus(func(s *updateInfo) { *s = info })
		return info, err
	}
	info.Asset = asset.Name
	info.AssetURL = asset.URL
	info.SHA256 = sum
	if rel.Version != "" && !versionGreater(rel.Version, agentVersion) {
		info.Available = false
		info.Phase = "idle"
	} else {
		info.Available = true
		info.Phase = "available"
	}
	setUpdateStatus(func(s *updateInfo) { *s = info })
	return info, nil
}

func startUpdate(a *Agent, req updateRequest) error {
	if req.Check {
		_, err := checkUpdate()
		return err
	}
	if !updateRunner.TryLock() {
		return fmt.Errorf("update already running")
	}
	setUpdateStatus(func(s *updateInfo) {
		s.Phase = "checking"
		s.Error = ""
	})
	go func() {
		defer updateRunner.Unlock()
		if err := applyUpdate(a, req); err != nil {
			a.mu.Lock()
			a.log("error", "update: "+err.Error())
			a.mu.Unlock()
			setUpdateStatus(func(s *updateInfo) {
				s.Phase = "error"
				s.Error = err.Error()
			})
			a.pushUI()
		}
	}()
	return nil
}

func applyUpdate(a *Agent, req updateRequest) error {
	setUpdateStatus(func(s *updateInfo) {
		s.Phase = "checking"
		s.Error = ""
	})
	a.mu.Lock()
	a.log("info", "update: checking")
	a.mu.Unlock()

	var assetURL, assetName, wantSum string
	if local := allowedLocalUpdatePath(strings.TrimSpace(req.URL)); local != "" {
		assetName = filepath.Base(local)
		assetURL = local
		wantSum = strings.ToLower(strings.TrimSpace(req.SHA256))
	} else if u := strings.TrimSpace(req.URL); u != "" {
		if !allowedUpdateURL(u) {
			return fmt.Errorf("update: blocked url")
		}
		assetName = filepath.Base(u)
		assetURL = u
		wantSum = strings.ToLower(strings.TrimSpace(req.SHA256))
		if wantSum == "" {
			if rel, err := discoverRelease(); err == nil {
				wantSum = checksumFor(rel.Sums, assetName)
			}
		}
	} else {
		info, err := checkUpdate()
		if err != nil {
			return err
		}
		if !info.Available && !req.Force {
			setUpdateStatus(func(s *updateInfo) {
				s.Phase = "idle"
				s.Available = false
				s.Error = ""
			})
			a.mu.Lock()
			a.log("info", "update: already current")
			a.mu.Unlock()
			return nil
		}
		assetURL = info.AssetURL
		assetName = info.Asset
		wantSum = info.SHA256
	}
	if wantSum == "" && !req.Force {
		return fmt.Errorf("update: missing checksum for %s", assetName)
	}

	dir := filepath.Join(fleetHome(), "updates")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	archive := filepath.Join(dir, assetName)
	setUpdateStatus(func(s *updateInfo) {
		s.Phase = "downloading"
		s.Asset = assetName
		s.AssetURL = assetURL
		s.SHA256 = wantSum
	})
	if local := allowedLocalUpdatePath(assetURL); local != "" {
		if err := copyFileReplace(local, archive); err != nil {
			return err
		}
	} else {
		if err := downloadTo(assetURL, archive); err != nil {
			return err
		}
	}

	setUpdateStatus(func(s *updateInfo) { s.Phase = "verifying" })
	got, err := fileSHA256(archive)
	if err != nil {
		return err
	}
	if wantSum != "" && got != wantSum {
		_ = os.Remove(archive)
		return fmt.Errorf("update: sha256 mismatch")
	}

	live, err := liveBinaryPath()
	if err != nil {
		return err
	}
	staged := stagedBinaryPath(live)
	setUpdateStatus(func(s *updateInfo) { s.Phase = "staging" })
	if err := extractAgentBinary(archive, staged); err != nil {
		return err
	}
	if err := os.Chmod(staged, 0o755); err != nil {
		return err
	}
	clearQuarantine(staged)

	handoffExe := staged
	extra := map[string]string{}
	if runtime.GOOS == "windows" {
		extra[promoteEnvKey] = live
	} else {
		if err := promoteUnix(staged, live); err != nil {
			a.mu.Lock()
			a.log("warn", "update: live replace failed, running staged sibling: "+err.Error())
			a.mu.Unlock()
		} else {
			handoffExe = live
		}
	}

	setUpdateStatus(func(s *updateInfo) {
		s.Phase = "restarting"
		s.Staged = staged
		s.Available = false
	})
	a.mu.Lock()
	a.log("info", "update: staged, restarting this listen addr")
	a.mu.Unlock()
	return a.handoffRestart(handoffExe, extra)
}

func promoteUnix(staged, live string) error {
	if staged == live {
		return nil
	}
	bak := backupBinaryPath(live)
	_ = os.Remove(bak)
	if _, err := os.Stat(live); err == nil {
		if err := os.Rename(live, bak); err != nil {
			if err := copyFileReplace(live, bak); err != nil {
				return err
			}
		}
	}
	if err := os.Rename(staged, live); err != nil {
		if err := copyFileReplace(staged, live); err != nil {
			if _, bakErr := os.Stat(bak); bakErr == nil {
				_ = os.Rename(bak, live)
			}
			return err
		}
		_ = os.Remove(staged)
	}
	return nil
}

func rollbackBinary() (string, error) {
	live, err := liveBinaryPath()
	if err != nil {
		return "", err
	}
	bak := backupBinaryPath(live)
	if _, err := os.Stat(bak); err != nil {
		return "", fmt.Errorf("no backup at %s", bak)
	}
	staged := stagedBinaryPath(live)
	if err := copyFileReplace(bak, staged); err != nil {
		return "", err
	}
	_ = os.Chmod(staged, 0o755)
	return staged, nil
}

func (a *Agent) requestRollback() error {
	staged, err := rollbackBinary()
	if err != nil {
		return err
	}
	extra := map[string]string{}
	exe := staged
	if runtime.GOOS == "windows" {
		if live, err := liveBinaryPath(); err == nil {
			extra[promoteEnvKey] = live
		}
	} else if live, err := liveBinaryPath(); err == nil {
		if err := promoteUnix(staged, live); err == nil {
			exe = live
		}
	}
	a.mu.Lock()
	a.log("info", "rollback: restarting previous binary")
	a.mu.Unlock()
	return a.handoffRestart(exe, extra)
}
