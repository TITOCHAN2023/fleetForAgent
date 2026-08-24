package main

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultUpdateFresh  = 10 * time.Minute
	autoUpdatePollEvery = 15 * time.Second
)

type versionSignal struct {
	Version      string
	Base         string
	URL          string
	SHA256       string
	ChecksumsURL string
	Sums         map[string]string
	Seen         time.Time
}

type autoUpdateDecision struct {
	Apply  bool
	Reason string
}

var (
	channelMu      sync.Mutex
	channelBase    string
	channelSumsURL string
	channelVer     string
	channelSums    map[string]string
)

func setUpdateChannel(base string) {
	channelMu.Lock()
	defer channelMu.Unlock()
	channelBase = strings.TrimRight(strings.TrimSpace(base), "/")
	if channelBase == "" {
		channelSumsURL = ""
		channelVer = ""
		channelSums = nil
	}
}

func rememberUpdateChannel(sig versionSignal) {
	channelMu.Lock()
	defer channelMu.Unlock()
	if sig.Base != "" {
		channelBase = strings.TrimRight(strings.TrimSpace(sig.Base), "/")
	}
	if sig.ChecksumsURL != "" {
		channelSumsURL = strings.TrimSpace(sig.ChecksumsURL)
	}
	if sig.Version != "" {
		channelVer = strings.TrimPrefix(strings.TrimSpace(sig.Version), "v")
	}
	if len(sig.Sums) > 0 {
		channelSums = sig.Sums
	}
}

func advertisedUpdateBase() string {
	channelMu.Lock()
	defer channelMu.Unlock()
	return channelBase
}

func advertisedChecksumsURL() string {
	channelMu.Lock()
	defer channelMu.Unlock()
	return channelSumsURL
}

func advertisedChannelVersion() string {
	channelMu.Lock()
	defer channelMu.Unlock()
	return channelVer
}

func advertisedChannelSums() map[string]string {
	channelMu.Lock()
	defer channelMu.Unlock()
	if len(channelSums) == 0 {
		return nil
	}
	out := make(map[string]string, len(channelSums))
	for k, v := range channelSums {
		out[k] = v
	}
	return out
}

func updateFreshWindow() time.Duration {
	if v := strings.TrimSpace(os.Getenv("FLEET_UPDATE_FRESH_S")); v != "" {
		n, err := strconv.Atoi(v)
		if err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
	}
	return defaultUpdateFresh
}

func parseVersionSignal(body map[string]any, now time.Time) (versionSignal, bool) {
	if body == nil {
		return versionSignal{}, false
	}
	ver := stringFromAny(body["latest_agent_ver"])
	if ver == "" {
		return versionSignal{}, false
	}
	return versionSignal{
		Version:      ver,
		Base:         stringFromAny(body["update_base"]),
		URL:          stringFromAny(body["update_url"]),
		SHA256:       strings.ToLower(stringFromAny(body["update_sha256"])),
		ChecksumsURL: stringFromAny(body["update_checksums"]),
		Sums:         sumsFromAny(body["update_sums"]),
		Seen:         now,
	}, true
}

func sumsFromAny(v any) map[string]string {
	m, ok := v.(map[string]any)
	if !ok || len(m) == 0 {
		return nil
	}
	out := map[string]string{}
	for name, raw := range m {
		sum := strings.ToLower(strings.TrimSpace(stringFromAny(raw)))
		if name == "" || len(sum) != 64 {
			continue
		}
		out[filepath.Base(name)] = sum
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func stringFromAny(v any) string {
	s, _ := v.(string)
	return strings.TrimSpace(s)
}

// decideAutoUpdate is the product gate. Toggle off never applies.
// Toggle on applies only when a newer version was seen within fresh AND idle.
func decideAutoUpdate(toggle, idle bool, current string, sig versionSignal, now time.Time, fresh time.Duration) autoUpdateDecision {
	if !toggle {
		return autoUpdateDecision{Reason: "toggle_off"}
	}
	if sig.Version == "" || sig.Seen.IsZero() {
		return autoUpdateDecision{Reason: "no_signal"}
	}
	if !versionGreater(sig.Version, current) {
		return autoUpdateDecision{Reason: "not_newer"}
	}
	if fresh <= 0 {
		fresh = defaultUpdateFresh
	}
	if now.Sub(sig.Seen) > fresh {
		return autoUpdateDecision{Reason: "stale"}
	}
	if !idle {
		return autoUpdateDecision{Reason: "busy"}
	}
	return autoUpdateDecision{Apply: true, Reason: "apply"}
}

func updateBusyPhase(phase string) bool {
	switch phase {
	case "checking", "downloading", "verifying", "staging", "restarting":
		return true
	default:
		return false
	}
}

func (s *supervisor) busy() bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.panes {
		if p != nil && p.stillRunning() {
			return true
		}
	}
	if s.live != nil && s.live.alive() && !s.live.idleExpired() {
		return true
	}
	for _, sl := range s.slots {
		if sl == nil {
			continue
		}
		if sl.pending != nil {
			return true
		}
		if sl.live != nil && sl.live.alive() && !sl.live.idleExpired() {
			return true
		}
	}
	return false
}

func (a *Agent) isIdleLocked() bool {
	if a.pending != nil || a.desktopPending != nil || a.restarting {
		return false
	}
	return !a.panes.busy()
}

func (a *Agent) noteHubUpdate(body map[string]any) {
	sig, ok := parseVersionSignal(body, time.Now())
	if !ok {
		return
	}
	a.mu.Lock()
	a.updateSig = sig
	a.mu.Unlock()
	rememberUpdateChannel(sig)
	newer := versionGreater(sig.Version, agentVersion)
	setUpdateStatus(func(s *updateInfo) {
		s.Latest = sig.Version
		s.Available = newer
		if sig.URL != "" {
			s.AssetURL = sig.URL
		}
		if sig.SHA256 != "" {
			s.SHA256 = sig.SHA256
		}
		if s.Phase == "idle" || s.Phase == "available" || s.Phase == "" {
			if newer {
				s.Phase = "available"
			} else {
				s.Phase = "idle"
			}
		}
	})
	go a.maybeAutoUpdate()
}

func (a *Agent) maybeAutoUpdate() {
	if updateBusyPhase(updateStatus().Phase) {
		return
	}
	a.mu.Lock()
	toggle := a.autoUpdate
	idle := a.isIdleLocked()
	sig := a.updateSig
	enabled := a.enabled
	a.mu.Unlock()
	if !enabled {
		return
	}
	d := decideAutoUpdate(toggle, idle, agentVersion, sig, time.Now(), updateFreshWindow())
	if !d.Apply {
		return
	}
	req := updateRequest{Force: true, URL: sig.URL, SHA256: sig.SHA256}
	if err := startUpdate(a, req); err != nil && !strings.Contains(err.Error(), "already running") {
		a.mu.Lock()
		a.log("warn", "auto-update: "+err.Error())
		a.mu.Unlock()
	}
}

func autoUpdatePoll() time.Duration {
	if v := strings.TrimSpace(os.Getenv("FLEET_UPDATE_POLL_S")); v != "" {
		n, err := strconv.Atoi(v)
		if err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
	}
	return autoUpdatePollEvery
}

func (a *Agent) autoUpdateLoop(ctx context.Context) {
	t := time.NewTicker(autoUpdatePoll())
	defer t.Stop()
	a.maybeAutoUpdate()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			a.mu.Lock()
			c := a.ws
			on := a.autoUpdate
			a.mu.Unlock()
			if on && c != nil {
				_ = a.sendPresence(ctx, c)
			}
			a.maybeAutoUpdate()
		}
	}
}

func (a *Agent) setAutoUpdate(on bool) {
	a.mu.Lock()
	a.autoUpdate = on
	a.save()
	a.log("info", map[bool]string{true: "auto-update on", false: "auto-update off"}[on])
	a.mu.Unlock()
	a.pushUI()
	if on {
		go a.maybeAutoUpdate()
	}
}
