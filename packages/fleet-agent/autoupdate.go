package main

import (
	"context"
	"os"
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
	Version string
	Base    string
	URL     string
	SHA256  string
	Seen    time.Time
}

type autoUpdateDecision struct {
	Apply  bool
	Reason string
}

var (
	channelMu   sync.Mutex
	channelBase string
)

func setUpdateChannel(base string) {
	channelMu.Lock()
	channelBase = strings.TrimRight(strings.TrimSpace(base), "/")
	channelMu.Unlock()
}

func advertisedUpdateBase() string {
	channelMu.Lock()
	defer channelMu.Unlock()
	return channelBase
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
		Version: ver,
		Base:    stringFromAny(body["update_base"]),
		URL:     stringFromAny(body["update_url"]),
		SHA256:  strings.ToLower(stringFromAny(body["update_sha256"])),
		Seen:    now,
	}, true
}

func stringFromAny(v any) string {
	s, _ := v.(string)
	return strings.TrimSpace(s)
}

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
	if sig.Base != "" {
		setUpdateChannel(sig.Base)
	}
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
}

func (a *Agent) maybeAutoUpdate() {
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
