package tray

func Clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

func clip(s string, n int) string { return Clip(s, n) }

func connLabel(s Snapshot) string {
	if s.PendingCommand != "" {
		return "Needs approval"
	}
	if !s.Enabled {
		return "Disabled"
	}
	switch s.Conn {
	case "online":
		return "Online"
	case "connecting":
		return "Connecting"
	case "error":
		if s.Error != "" {
			return "Error: " + clip(s.Error, 48)
		}
		return "Error"
	default:
		return "Offline"
	}
}

func trayTitle(s Snapshot) string {
	if s.PendingCommand != "" {
		return "F?"
	}
	if !s.Enabled {
		return "F"
	}
	switch s.Conn {
	case "online":
		return "F•"
	case "connecting":
		return "F…"
	case "error":
		return "F!"
	default:
		return "F"
	}
}

func trayTooltip(s Snapshot) string {
	id := s.DeviceID
	if len(id) > 8 {
		id = id[:8]
	}
	return "Fleet Agent " + id + " — " + connLabel(s)
}
