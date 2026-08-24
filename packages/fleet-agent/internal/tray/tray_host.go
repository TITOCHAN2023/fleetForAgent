//go:build darwin || windows || linux

package tray

import (
	"log"
	"os"
	"runtime"
	"time"

	"github.com/energye/systray"
)

const Enabled = true

type trayMenu struct {
	status     *systray.MenuItem
	open       *systray.MenuItem
	reconnect  *systray.MenuItem
	enabled    *systray.MenuItem
	off        *systray.MenuItem
	ask        *systray.MenuItem
	allow      *systray.MenuItem
	consent    *systray.MenuItem
	deny       *systray.MenuItem
	restart    *systray.MenuItem
	autoUpdate *systray.MenuItem
	quit       *systray.MenuItem
	ready      bool
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
		systray.SetIcon(trayPNG(false))
	}
}

func Run(c Controller) {
	if !linuxHasPanel() {
		log.Println("tray: no graphical session, running in background")
		select {}
	}
	systray.Run(func() { onTrayReady(c) }, func() { c.OnQuit() })
}

func onTrayReady(c Controller) {
	applyTrayIcon()
	systray.SetTitle("")
	systray.SetTooltip("Fleet Agent")

	// Windows: left click opens the page, right click is the switch menu.
	// Mac: click shows the menu. Linux: no settings page; the dbus menu is the UI.
	switch runtime.GOOS {
	case "windows":
		systray.SetOnClick(func(systray.IMenu) { c.OpenSettings() })
		systray.SetOnDClick(func(systray.IMenu) { c.OpenSettings() })
		systray.SetOnRClick(func(m systray.IMenu) { _ = m.ShowMenu() })
	case "linux":
		// StatusNotifierItem shows the dbus menu on right-click. Do not open a browser.
	default:
		systray.SetOnRClick(func(m systray.IMenu) { _ = m.ShowMenu() })
	}

	tray.status = systray.AddMenuItem("Offline", "")
	tray.status.Disable()
	tray.open = systray.AddMenuItem("Open Settings", "")
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
	tray.restart = systray.AddMenuItem("Restart", "Respawn this agent on its listen address")
	tray.autoUpdate = systray.AddMenuItemCheckbox("Auto-update", "When idle, install a newer version advertised by the hub", true)
	systray.AddSeparator()
	tray.quit = systray.AddMenuItem("Quit Fleet Agent", "")

	tray.open.Click(func() { c.OpenSettings() })
	tray.reconnect.Click(func() { c.Reconnect() })
	tray.enabled.Click(func() {
		s := c.TraySnapshot()
		c.SetEnabled(!s.Enabled)
	})
	tray.off.Click(func() { c.SetPermit("off") })
	tray.ask.Click(func() { c.SetPermit("ask") })
	tray.allow.Click(func() { c.SetPermit("allow") })
	tray.consent.Click(func() { c.Approve() })
	tray.deny.Click(func() { c.Deny() })
	tray.restart.Click(func() { go c.RequestRestart() })
	tray.autoUpdate.Click(func() {
		s := c.TraySnapshot()
		c.SetAutoUpdate(!s.AutoUpdate)
	})
	tray.quit.Click(func() { systray.Quit() })

	tray.ready = true
	Update(c.TraySnapshot())
	go func() {
		time.Sleep(400 * time.Millisecond)
		applyTrayIcon()
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for range t.C {
			Update(c.TraySnapshot())
		}
	}()
}

func Update(s Snapshot) {
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
	if s.AutoUpdate {
		tray.autoUpdate.Check()
		tray.autoUpdate.SetTitle("Auto-update on")
	} else {
		tray.autoUpdate.Uncheck()
		tray.autoUpdate.SetTitle("Auto-update off")
	}
	checkOnly(tray.off, s.Permit == "off")
	checkOnly(tray.ask, s.Permit == "ask")
	checkOnly(tray.allow, s.Permit == "allow")
	if s.PendingCommand != "" {
		tray.consent.SetTitle("Allow: " + clip(s.PendingCommand, 42))
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

func RequestQuit() {
	if runtime.GOOS == "linux" && !linuxHasPanel() {
		os.Exit(0)
	}
	systray.Quit()
}
