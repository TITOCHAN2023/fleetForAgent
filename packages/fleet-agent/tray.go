package main

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

func connLabel(s State) string {
	if s.Pending != nil {
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

func trayTitle(s State) string {
	if s.Pending != nil {
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

func trayTooltip(s State) string {
	id := s.DeviceID
	if len(id) > 8 {
		id = id[:8]
	}
	return "Fleet Agent " + id + " — " + connLabel(s)
}
