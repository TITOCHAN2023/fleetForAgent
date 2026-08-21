//go:build darwin || windows || linux

package main

import (
	"log"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/energye/systray"
)

const trayEnabled = true

type trayMenu struct {
	status    *systray.MenuItem
	open      *systray.MenuItem
	reconnect *systray.MenuItem
	enabled   *systray.MenuItem
	off     *systray.MenuItem
	ask     *systray.MenuItem
	allow   *systray.MenuItem
	consent *systray.MenuItem
	deny    *systray.MenuItem
	quit    *systray.MenuItem
	ready   bool
}

var tray trayMenu

func linuxHasPanel() bool {
	if runtime.GOOS != "linux" {
		return true
	}
	return os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != "" || os.Getenv("DBUS_SESSION_BUS_ADDRESS") != ""
}

func applyTrayIcon() {
	switch runtime.GOOS {
	case "windows":
		systray.SetIcon(trayICO())
	case "linux":
		systray.SetIcon(trayPNG(false))
	default:
		png := trayPNG(true)
		systray.SetTemplateIcon(png, png)
	}
}

func runTray(a *Agent) {
	if !linuxHasPanel() {
		log.Println("tray: no graphical session, running in background")
		select {}
	}
	systray.Run(func() { onTrayReady(a) }, func() {
		a.mu.Lock()
		a.disconnectLocked("quit")
		a.mu.Unlock()
		setKeepAlive(false)
	})
}

func onTrayReady(a *Agent) {
	applyTrayIcon()
	systray.SetTitle("F")
	systray.SetTooltip("Fleet Agent")

	// Windows: left click opens the page, right click is the switch menu.
	// Mac: click shows the menu. Linux: no settings page; the dbus menu is the UI.
	switch runtime.GOOS {
	case "windows":
		systray.SetOnClick(func(systray.IMenu) { openBrowser(settingsURL) })
		systray.SetOnDClick(func(systray.IMenu) { openBrowser(settingsURL) })
		systray.SetOnRClick(func(m systray.IMenu) { _ = m.ShowMenu() })
	case "linux":
		// StatusNotifierItem shows the dbus menu on right-click. Do not open a browser.
	default:
		systray.SetOnRClick(func(m systray.IMenu) { _ = m.ShowMenu() })
	}

	tray.status = systray.AddMenuItem("Offline", "")
	tray.status.Disable()
	tray.open = systray.AddMenuItem("Open Settings", settingsURL)
	tray.reconnect = systray.AddMenuItem("Reconnect", "")
	if runtime.GOOS == "linux" {
		tray.open.Hide()
	} else {
		tray.reconnect.Hide()
	}
	systray.AddSeparator()
	tray.enabled = systray.AddMenuItemCheckbox("Enabled", "Allow this computer to run", false)
	tray.off = systray.AddMenuItemCheckbox("Refuse all", "", false)
	tray.ask = systray.AddMenuItemCheckbox("Ask at the machine", "", true)
	tray.allow = systray.AddMenuItemCheckbox("Allow all", "", false)
	systray.AddSeparator()
	tray.consent = systray.AddMenuItem("Allow command", "")
	tray.deny = systray.AddMenuItem("Deny", "")
	tray.consent.Hide()
	tray.deny.Hide()
	systray.AddSeparator()
	tray.quit = systray.AddMenuItem("Quit Fleet Agent", "")

	tray.open.Click(func() { openBrowser(settingsURL) })
	tray.reconnect.Click(func() {
		a.mu.Lock()
		hub := a.hubInput
		a.mu.Unlock()
		if strings.TrimSpace(hub) != "" {
			go func() { _ = a.connect(hub) }()
		}
	})
	tray.enabled.Click(func() {
		a.mu.Lock()
		on := !a.enabled
		a.mu.Unlock()
		a.setEnabled(on)
	})
	tray.off.Click(func() { a.setPermit(PermitOff) })
	tray.ask.Click(func() { a.setPermit(PermitAsk) })
	tray.allow.Click(func() { a.setPermit(PermitAllow) })
	tray.consent.Click(func() { a.approve(); a.pushUI() })
	tray.deny.Click(func() { a.deny(); a.pushUI() })
	tray.quit.Click(func() { systray.Quit() })

	tray.ready = true
	a.pushUI()
	go func() {
		time.Sleep(400 * time.Millisecond)
		applyTrayIcon()
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for range t.C {
			a.pushUI()
		}
	}()
}

func updateTray(s State) {
	if !tray.ready {
		return
	}
	systray.SetTitle(trayTitle(s))
	systray.SetTooltip(trayTooltip(s))
	tray.status.SetTitle(connLabel(s))
	if s.Enabled {
		tray.enabled.Check()
		tray.enabled.SetTitle("Enabled")
	} else {
		tray.enabled.Uncheck()
		tray.enabled.SetTitle("Disabled")
	}
	checkOnly(tray.off, s.Permit == PermitOff)
	checkOnly(tray.ask, s.Permit == PermitAsk)
	checkOnly(tray.allow, s.Permit == PermitAllow)
	if s.Pending != nil {
		tray.consent.SetTitle("Allow: " + clip(s.Pending.Command, 42))
		tray.consent.Show()
		tray.deny.Show()
	} else {
		tray.consent.Hide()
		tray.deny.Hide()
	}
}

func checkOnly(item *systray.MenuItem, on bool) {
	if on {
		item.Check()
	} else {
		item.Uncheck()
	}
}

func requestQuit() {
	if runtime.GOOS == "linux" && !linuxHasPanel() {
		os.Exit(0)
	}
	systray.Quit()
}
