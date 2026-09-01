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
	"path"
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
	maxUpdateBytes    = int64(256 << 20)
)

type updateTrustPolicy struct {
	HubOrigin             string
	AllowConfiguredSource bool
}

type updateRequest struct {
	URL         string `json:"url"`
	SHA256      string `json:"sha256"`
	Force       bool   `json:"force"`
	Check       bool   `json:"check"`
	Auto        bool   `json:"-"`
	VersionHint string `json:"-"`
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
	return defaultUpdateBase
}

func updateAPI() string {
	if v, ok := os.LookupEnv("FLEET_UPDATE_API"); ok {
		return strings.TrimSpace(v)
	}
	if strings.TrimSpace(os.Getenv("FLEET_UPDATE_BASE")) != "" {
		return ""
	}
	return defaultUpdateAPI
}

// automaticUpdateChannel is deliberately narrower than the manual channel.
// A hub may advertise that a version exists, but it never chooses the binary
// or its checksum. Production auto-update is pinned to the official repo.
// A loopback base is the sole exception, used by the real-process update lab.
func automaticUpdateChannel() (base, api string) {
	if candidate := strings.TrimRight(strings.TrimSpace(os.Getenv("FLEET_UPDATE_BASE")), "/"); candidate != "" {
		if u, err := url.Parse(candidate); err == nil && isLoopbackUpdateURL(u) {
			api = strings.TrimSpace(os.Getenv("FLEET_UPDATE_API"))
			if api != "" {
				if apiURL, err := url.Parse(api); err != nil || !isLoopbackUpdateURL(apiURL) {
					api = ""
				}
			}
			return candidate, api
		}
	}
	return defaultUpdateBase, defaultUpdateAPI
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
		sum, ok := normalizeSHA256(fields[0])
		if !ok {
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
	if s, ok := normalizeSHA256(sums[name]); ok {
		return s
	}
	s, _ := normalizeSHA256(sums[filepath.Base(name)])
	return s
}

func normalizeSHA256(raw string) (string, bool) {
	s := strings.ToLower(strings.TrimSpace(raw))
	if len(s) != sha256.Size*2 {
		return "", false
	}
	if _, err := hex.DecodeString(s); err != nil {
		return "", false
	}
	return s, true
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

func isLoopbackUpdateURL(u *url.URL) bool {
	if u == nil || u.User != nil || u.Host == "" {
		return false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return false
	}
	host := u.Hostname()
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func isOfficialFleetUpdateURL(u *url.URL) bool {
	if u == nil || u.User != nil || !strings.EqualFold(u.Scheme, "https") || u.Port() != "" {
		return false
	}
	escapedPath := u.EscapedPath()
	if strings.Contains(escapedPath, "%") || path.Clean(escapedPath) != escapedPath {
		return false
	}
	switch strings.ToLower(u.Hostname()) {
	case "github.com":
		return strings.HasPrefix(escapedPath, "/TITOCHAN2023/fleetForAgent/releases/")
	case "api.github.com":
		return strings.HasPrefix(escapedPath, "/repos/TITOCHAN2023/fleetForAgent/releases/")
	default:
		return false
	}
}

func sameUpdateOrigin(u *url.URL, rawOrigin string) bool {
	if u == nil || u.User != nil || strings.TrimSpace(rawOrigin) == "" {
		return false
	}
	origin, err := url.Parse(rawOrigin)
	if err != nil || origin.User != nil || origin.Host == "" {
		return false
	}
	return strings.EqualFold(u.Scheme, origin.Scheme) &&
		strings.EqualFold(u.Hostname(), origin.Hostname()) &&
		effectivePort(u) == effectivePort(origin)
}

func effectivePort(u *url.URL) string {
	if p := u.Port(); p != "" {
		return p
	}
	switch strings.ToLower(u.Scheme) {
	case "https", "wss":
		return "443"
	case "http", "ws":
		return "80"
	default:
		return ""
	}
}

func trustedHubUpdateOrigin(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.User != nil || u.Host == "" {
		return ""
	}
	switch strings.ToLower(u.Scheme) {
	case "wss":
		u.Scheme = "https"
	case "ws":
		u.Scheme = "http"
	case "https", "http":
	default:
		return ""
	}
	if u.Scheme == "http" && !isLoopbackUpdateURL(u) {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

func agentUpdateHubOrigin(a *Agent) string {
	if a == nil {
		return ""
	}
	a.mu.Lock()
	raw := a.wss
	if strings.TrimSpace(raw) == "" {
		raw = a.hubInput
	}
	a.mu.Unlock()
	return trustedHubUpdateOrigin(raw)
}

func configuredManualUpdateOrigins() []string {
	origins := make([]string, 0, 2)
	seen := map[string]bool{}
	for _, raw := range []string{os.Getenv("FLEET_UPDATE_BASE"), os.Getenv("FLEET_UPDATE_API")} {
		origin := trustedHubUpdateOrigin(raw)
		if origin != "" && !seen[origin] {
			origins = append(origins, origin)
			seen[origin] = true
		}
	}
	return origins
}

func allowedUpdateURLWithPolicy(raw string, policy updateTrustPolicy) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Fragment != "" || u.User != nil {
		return false
	}
	if isOfficialFleetUpdateURL(u) || isLoopbackUpdateURL(u) {
		return true
	}
	if strings.EqualFold(u.Scheme, "https") && sameUpdateOrigin(u, policy.HubOrigin) {
		return true
	}
	if policy.AllowConfiguredSource {
		for _, origin := range configuredManualUpdateOrigins() {
			if sameUpdateOrigin(u, origin) {
				return true
			}
		}
	}
	return false
}

func allowedUpdateURLForHub(raw, hubOrigin string) bool {
	return allowedUpdateURLWithPolicy(raw, updateTrustPolicy{HubOrigin: hubOrigin})
}

func allowedUpdateURL(raw string) bool {
	return allowedUpdateURLWithPolicy(raw, updateTrustPolicy{AllowConfiguredSource: true})
}

func allowedLocalUpdatePath(raw string) string {
	if raw == "" {
		return ""
	}
	if strings.Contains(raw, "://") {
		u, err := url.Parse(raw)
		if err != nil || u.Scheme != "file" || (u.Host != "" && !strings.EqualFold(u.Host, "localhost")) {
			return ""
		}
		return u.Path
	}
	if filepath.IsAbs(raw) {
		return raw
	}
	return ""
}

func remoteUpdateAssetName(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	name := path.Base(u.Path)
	if name == "" || name == "." || name == ".." || name == "/" {
		return ""
	}
	return name
}

func isGitHubReleaseAssetURL(u *url.URL) bool {
	if u == nil || u.User != nil || !strings.EqualFold(u.Scheme, "https") || u.Port() != "" {
		return false
	}
	switch strings.ToLower(u.Hostname()) {
	case "release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com":
		return true
	default:
		return false
	}
}

func updateClientForPolicy(policy updateTrustPolicy) *http.Client {
	client := *updateHTTP
	priorCheck := client.CheckRedirect
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return fmt.Errorf("update: too many redirects")
		}
		allowed := allowedUpdateURLWithPolicy(req.URL.String(), policy)
		if !allowed && isGitHubReleaseAssetURL(req.URL) {
			for _, previous := range via {
				if isOfficialFleetUpdateURL(previous.URL) {
					allowed = true
					break
				}
			}
		}
		if !allowed {
			return fmt.Errorf("update: blocked redirect")
		}
		if priorCheck != nil {
			return priorCheck(req, via)
		}
		return nil
	}
	return &client
}

func updateClientFor(hubOrigin string) *http.Client {
	return updateClientForPolicy(updateTrustPolicy{HubOrigin: hubOrigin, AllowConfiguredSource: true})
}

func fetchBytesWithPolicy(raw string, policy updateTrustPolicy) ([]byte, error) {
	if !allowedUpdateURLWithPolicy(raw, policy) {
		return nil, fmt.Errorf("update: blocked url")
	}
	req, err := http.NewRequest(http.MethodGet, raw, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Fleet-Agent/"+agentVersion)
	req.Header.Set("Accept", "application/octet-stream, text/plain, application/json")
	res, err := updateClientForPolicy(policy).Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return nil, fmt.Errorf("update: http %s", res.Status)
	}
	if res.ContentLength > 8<<20 {
		return nil, fmt.Errorf("update: metadata exceeds 8 MiB")
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, (8<<20)+1))
	if err != nil {
		return nil, err
	}
	if len(b) > 8<<20 {
		return nil, fmt.Errorf("update: metadata exceeds 8 MiB")
	}
	return b, nil
}

func downloadToWithPolicy(raw, dest string, policy updateTrustPolicy) error {
	if !allowedUpdateURLWithPolicy(raw, policy) {
		return fmt.Errorf("update: blocked url")
	}
	req, err := http.NewRequest(http.MethodGet, raw, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Fleet-Agent/"+agentVersion)
	res, err := updateClientForPolicy(policy).Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("update: http %s", res.Status)
	}
	return writeUpdateBody(dest, res.Body, res.ContentLength, maxUpdateBytes)
}

func writeUpdateBody(dest string, body io.Reader, contentLength, maxBytes int64) error {
	if maxBytes <= 0 {
		return fmt.Errorf("update: invalid download limit")
	}
	if contentLength > maxBytes {
		return fmt.Errorf("update: asset exceeds %d bytes", maxBytes)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	n, copyErr := io.Copy(f, io.LimitReader(body, maxBytes+1))
	closeErr := f.Close()
	if copyErr != nil {
		_ = os.Remove(dest)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(dest)
		return closeErr
	}
	if n > maxBytes {
		_ = os.Remove(dest)
		return fmt.Errorf("update: asset exceeds %d bytes", maxBytes)
	}
	return nil
}

func discoverRelease() (*discoveredRelease, error) {
	return discoverReleaseAt("", updateBase(), updateAPI(), updateTrustPolicy{AllowConfiguredSource: true})
}

func discoverAutomaticRelease(versionHint string) (*discoveredRelease, error) {
	base, api := automaticUpdateChannel()
	policy := updateTrustPolicy{}
	if base == defaultUpdateBase {
		// In production the hub only wakes the checker. GitHub's release API,
		// not the hub's claimed version, decides whether an update exists.
		versionHint = ""
	}
	rel, err := discoverReleaseAt(versionHint, base, api, policy)
	if err != nil {
		return nil, err
	}
	if base == defaultUpdateBase && rel.Version == "" {
		return nil, fmt.Errorf("update: official release version could not be verified")
	}
	return rel, nil
}

func discoverReleaseAt(versionHint, base, api string, policy updateTrustPolicy) (*discoveredRelease, error) {
	rel := &discoveredRelease{
		Version: strings.TrimPrefix(strings.TrimSpace(versionHint), "v"),
		Sums:    map[string]string{},
	}
	if api != "" {
		if err := fillReleaseFromAPI(rel, api, policy); err != nil && base == defaultUpdateBase {
			// still try constructed latest/download URLs below
		}
	}
	if len(rel.Assets) == 0 && base != "" {
		for _, name := range releaseAssetNames(runtime.GOOS, runtime.GOARCH) {
			rel.Assets = append(rel.Assets, releaseAsset{Name: name, URL: base + "/" + name})
		}
	}
	if checksumsNeedFetch(rel) {
		for k, v := range fetchChecksums(rel, base, policy) {
			if rel.Sums == nil {
				rel.Sums = map[string]string{}
			}
			if rel.Sums[k] == "" {
				rel.Sums[k] = v
			}
		}
	}
	if len(rel.Assets) == 0 {
		return nil, fmt.Errorf("update: no assets for %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	return rel, nil
}

func fillReleaseFromAPI(rel *discoveredRelease, api string, policy updateTrustPolicy) error {
	b, err := fetchBytesWithPolicy(api, policy)
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
		if b, err := fetchBytesWithPolicy(s.URL, policy); err == nil {
			for k, v := range parseChecksums(string(b)) {
				rel.Sums[k] = v
			}
		}
	}
	return nil
}

func checksumsNeedFetch(rel *discoveredRelease) bool {
	if rel == nil || len(rel.Sums) == 0 {
		return true
	}
	for _, name := range releaseAssetNames(runtime.GOOS, runtime.GOARCH) {
		if checksumFor(rel.Sums, name) == "" {
			return true
		}
	}
	return false
}

func fetchChecksums(rel *discoveredRelease, base string, policy updateTrustPolicy) map[string]string {
	out := map[string]string{}
	candidates := []string{}
	if base != "" {
		candidates = append(candidates, base+"/checksums.txt")
		ver := ""
		if rel != nil {
			ver = rel.Version
		}
		if ver != "" {
			candidates = append(candidates, base+"/checksums-"+strings.TrimPrefix(ver, "v")+".txt")
		}
	}
	seen := map[string]bool{}
	for _, u := range candidates {
		if seen[u] {
			continue
		}
		seen[u] = true
		b, err := fetchBytesWithPolicy(u, policy)
		if err != nil {
			continue
		}
		for k, v := range parseChecksums(string(b)) {
			out[k] = v
		}
	}
	return out
}

func pickAssetWithPolicy(rel *discoveredRelease, policy updateTrustPolicy) (releaseAsset, string, error) {
	if rel == nil {
		return releaseAsset{}, "", fmt.Errorf("update: no release")
	}
	for _, name := range releaseAssetNames(runtime.GOOS, runtime.GOARCH) {
		for _, a := range rel.Assets {
			if a.Name == name && a.URL != "" {
				if !allowedUpdateURLWithPolicy(a.URL, policy) {
					return releaseAsset{}, "", fmt.Errorf("update: blocked url")
				}
				sum := checksumFor(rel.Sums, name)
				if sum == "" {
					return releaseAsset{}, "", fmt.Errorf("update: missing or invalid sha256 for %s", name)
				}
				return a, sum, nil
			}
		}
	}
	return releaseAsset{}, "", fmt.Errorf("update: no %s/%s asset on this channel", runtime.GOOS, runtime.GOARCH)
}

func pickAsset(rel *discoveredRelease) (releaseAsset, string, error) {
	return pickAssetWithPolicy(rel, updateTrustPolicy{AllowConfiguredSource: true})
}

func checkUpdate() (updateInfo, error) {
	rel, err := discoverRelease()
	return checkDiscoveredUpdate(rel, err, updateTrustPolicy{AllowConfiguredSource: true})
}

func checkAutomaticUpdate(versionHint string) (updateInfo, error) {
	rel, err := discoverAutomaticRelease(versionHint)
	return checkDiscoveredUpdate(rel, err, updateTrustPolicy{})
}

func checkDiscoveredUpdate(rel *discoveredRelease, err error, policy updateTrustPolicy) (updateInfo, error) {
	info := updateInfo{Current: agentVersion, Phase: "idle"}
	if err != nil {
		info.Phase = "error"
		info.Error = err.Error()
		setUpdateStatus(func(s *updateInfo) { *s = info })
		return info, err
	}
	info.Latest = rel.Version
	asset, sum, err := pickAssetWithPolicy(rel, policy)
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
	hubOrigin := ""
	downloadPolicy := updateTrustPolicy{AllowConfiguredSource: true}
	if req.Auto {
		downloadPolicy = updateTrustPolicy{}
		info, err := checkAutomaticUpdate(req.VersionHint)
		if err != nil {
			return err
		}
		if !info.Available {
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
	} else if local := allowedLocalUpdatePath(strings.TrimSpace(req.URL)); local != "" {
		assetName = filepath.Base(local)
		if assetName == "" || assetName == "." || assetName == ".." || assetName == string(filepath.Separator) {
			return fmt.Errorf("update: missing asset name")
		}
		assetURL = local
		wantSum = req.SHA256
	} else if u := strings.TrimSpace(req.URL); u != "" {
		hubOrigin = agentUpdateHubOrigin(a)
		downloadPolicy.HubOrigin = hubOrigin
		if !allowedUpdateURLWithPolicy(u, downloadPolicy) {
			return fmt.Errorf("update: blocked url")
		}
		assetName = remoteUpdateAssetName(u)
		if assetName == "" {
			return fmt.Errorf("update: missing asset name")
		}
		assetURL = u
		wantSum = req.SHA256
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
	wantSum, ok := normalizeSHA256(wantSum)
	if !ok {
		return fmt.Errorf("update: missing or invalid sha256 for %s", assetName)
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
		if err := copyFileReplaceLimited(local, archive, maxUpdateBytes); err != nil {
			return err
		}
	} else {
		if err := downloadToWithPolicy(assetURL, archive, downloadPolicy); err != nil {
			return err
		}
	}
	defer os.Remove(archive)

	setUpdateStatus(func(s *updateInfo) { s.Phase = "verifying" })
	got, err := fileSHA256(archive)
	if err != nil {
		return err
	}
	if got != wantSum {
		_ = os.Remove(archive)
		return fmt.Errorf("update: sha256 mismatch")
	}

	live, err := liveBinaryPath()
	if err != nil {
		return err
	}
	setUpdateStatus(func(s *updateInfo) { s.Phase = "staging" })
	staged, err := stageUpdateArtifact(archive, live)
	if err != nil {
		return err
	}

	handoffExe := staged
	extra := map[string]string{}
	if runtime.GOOS == "windows" {
		extra[promoteEnvKey] = live
	} else {
		if err := promoteUpdateArtifact(staged, live); err != nil {
			if updateNeedsAtomicBundlePromotion(live) {
				return err
			}
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
	live, err := liveBinaryPath()
	if err != nil {
		return err
	}
	if exe, handled, err := rollbackBundledApp(live); handled {
		if err != nil {
			return err
		}
		a.mu.Lock()
		a.log("info", "rollback: restarting previous app bundle")
		a.mu.Unlock()
		return a.handoffRestart(exe, nil)
	}
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
