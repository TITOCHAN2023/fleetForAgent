package main

import (
	"context"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	defaultUpdateFresh  = 10 * time.Minute
	autoUpdatePollEvery = 15 * time.Second
)

type versionSignal struct {
	Version string
	Seen    time.Time
}

type autoUpdateDecision struct {
	Apply  bool
	Reason string
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
		Seen:    now,
	}, true
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

func (a *Agent) isIdleLocked() bool {
	if a.pending != nil || a.desktopPending != nil || a.restarting {
		return false
	}
	return !a.panes.Busy()
}

func (a *Agent) noteHubUpdate(body map[string]any) {
	sig, ok := parseVersionSignal(body, time.Now())
	if !ok {
		return
	}
	a.mu.Lock()
	a.updateSig = sig
	a.mu.Unlock()
	newer := versionGreater(sig.Version, agentVersion)
	setUpdateStatus(func(s *updateInfo) {
		s.Latest = sig.Version
		s.Available = newer
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
	// The hub is only a version hint. Auto-update never accepts a binary URL,
	// checksum, or mirror from that control plane; applyUpdate discovers the
	// fixed official release channel (loopback is allowed only for tests).
	req := updateRequest{Auto: true, VersionHint: sig.Version}
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
