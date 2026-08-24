package main

import (
	"strings"

	"github.com/TITOCHAN2023/fleetForAgent/internal/keepalive"
	"github.com/TITOCHAN2023/fleetForAgent/internal/tray"
)

var _ tray.Controller = (*Agent)(nil)

func traySnap(s State) tray.Snapshot {
	cmd := ""
	if s.Pending != nil {
		cmd = s.Pending.Command
	}
	return tray.Snapshot{
		Enabled:        s.Enabled,
		AutoUpdate:     s.AutoUpdate,
		Permit:         string(s.Permit),
		Conn:           s.Conn,
		Error:          s.Error,
		DeviceID:       s.DeviceID,
		PendingCommand: cmd,
	}
}

func (a *Agent) TraySnapshot() tray.Snapshot {
	a.mu.Lock()
	defer a.mu.Unlock()
	return traySnap(a.snapshot())
}

func (a *Agent) SetEnabled(on bool) { a.setEnabled(on) }

func (a *Agent) SetPermit(p string) { a.setPermit(Permit(p)) }

func (a *Agent) Approve() { a.approve() }

func (a *Agent) Deny() { a.deny() }

func (a *Agent) Reconnect() {
	a.mu.Lock()
	hub := a.hubInput
	a.mu.Unlock()
	if strings.TrimSpace(hub) == "" {
		return
	}
	go func() { _ = a.connect(hub) }()
}

func (a *Agent) RequestRestart() { _ = a.requestRestart() }

func (a *Agent) SetAutoUpdate(on bool) { a.setAutoUpdate(on) }

func (a *Agent) OpenSettings() { openBrowser(settingsURL()) }

func (a *Agent) OnQuit() { keepalive.Set(false) }
