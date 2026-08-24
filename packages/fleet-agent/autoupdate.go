package main

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultUpdateFresh = 10 * time.Minute
	updateArmPollEvery = 15 * time.Second
)

type versionSignal struct {
	Version string
	Base    string
	URL     string
	SHA256  string
	Seen    time.Time
}

type updateArmDecision struct {
	Armed  bool
	Reason string
}

var (
	errUpdateNotArmed = fmt.Errorf("update: button not armed")

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

// decideUpdateArm is the product gate for the settings/tray Update button.
// Heartbeat only detects; a click applies. Armed only when a newer version
// was seen within fresh AND the agent is idle.
func decideUpdateArm(idle bool, current string, sig versionSignal, now time.Time, fresh time.Duration) updateArmDecision {
	if sig.Version == "" || sig.Seen.IsZero() {
		return updateArmDecision{Reason: "no_signal"}
	}
	if !versionGreater(sig.Version, current) {
		return updateArmDecision{Reason: "not_newer"}
	}
	if fresh <= 0 {
		fresh = defaultUpdateFresh
	}
	if now.Sub(sig.Seen) > fresh {
		return updateArmDecision{Reason: "stale"}
	}
	if !idle {
		return updateArmDecision{Reason: "busy"}
	}
	return updateArmDecision{Armed: true, Reason: "armed"}
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

func (a *Agent) updateArmedLocked() bool {
	if updateBusyPhase(updateStatus().Phase) {
		return false
	}
	return decideUpdateArm(a.isIdleLocked(), agentVersion, a.updateSig, time.Now(), updateFreshWindow()).Armed
}

func (a *Agent) updateArmedNow() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.updateArmedLocked()
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
	a.refreshUpdateArm()
}

func (a *Agent) refreshUpdateArm() {
	a.mu.Lock()
	armed := a.updateArmedLocked()
	a.mu.Unlock()
	setUpdateStatus(func(s *updateInfo) {
		s.Armed = armed
	})
	a.pushUI()
}

func updateArmPoll() time.Duration {
	if v := strings.TrimSpace(os.Getenv("FLEET_UPDATE_POLL_S")); v != "" {
		n, err := strconv.Atoi(v)
		if err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
	}
	return updateArmPollEvery
}

func (a *Agent) updateArmLoop(ctx context.Context) {
	t := time.NewTicker(updateArmPoll())
	defer t.Stop()
	a.refreshUpdateArm()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			a.mu.Lock()
			c := a.ws
			a.mu.Unlock()
			if c != nil {
				_ = a.sendPresence(ctx, c)
			}
			a.refreshUpdateArm()
		}
	}
}

// acceptUpdateClick is the settings/tray/CLI Update action. Heartbeat never
// calls this. --force or an explicit URL is an operator override.
func acceptUpdateClick(a *Agent, req updateRequest) error {
	if req.Check {
		return startUpdate(a, req)
	}
	explicit := req.Force || strings.TrimSpace(req.URL) != ""
	if !explicit && !a.updateArmedNow() {
		return errUpdateNotArmed
	}
	a.mu.Lock()
	sig := a.updateSig
	a.mu.Unlock()
	if strings.TrimSpace(req.URL) == "" {
		req.URL = sig.URL
		if strings.TrimSpace(req.SHA256) == "" {
			req.SHA256 = sig.SHA256
		}
	}
	return startUpdate(a, req)
}
