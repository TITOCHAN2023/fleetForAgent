package desktop

import "strings"

func splitKeySpec(spec string) []string {
	s := strings.ToLower(strings.TrimSpace(spec))
	if s == "" {
		return nil
	}
	s = strings.ReplaceAll(s, " ", "")
	parts := strings.Split(s, "+")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		switch p {
		case "control":
			p = "ctrl"
		case "return":
			p = "enter"
		case "cmd", "super", "meta":
			p = "win"
		case "esc":
			p = "escape"
		}
		out = append(out, p)
	}
	return out
}

// ANSI US virtual keycodes. Parsed in Go so CGO never strtok's a shared spec.
func darwinKeyCode(name string) (uint16, bool) {
	switch name {
	case "enter", "return":
		return 36, true
	case "tab":
		return 48, true
	case "esc", "escape":
		return 53, true
	case "space":
		return 49, true
	case "backspace":
		return 51, true
	case "delete", "del":
		return 117, true
	case "up":
		return 126, true
	case "down":
		return 125, true
	case "left":
		return 123, true
	case "right":
		return 124, true
	case "home":
		return 115, true
	case "end":
		return 119, true
	case "pageup":
		return 116, true
	case "pagedown":
		return 121, true
	case "ctrl", "control":
		return 59, true
	case "shift":
		return 56, true
	case "alt":
		return 58, true
	case "win", "cmd", "super", "meta":
		return 55, true
	case "f1":
		return 122, true
	case "f2":
		return 120, true
	case "f3":
		return 99, true
	case "f4":
		return 118, true
	case "f5":
		return 96, true
	case "f6":
		return 97, true
	case "f7":
		return 98, true
	case "f8":
		return 100, true
	case "f9":
		return 101, true
	case "f10":
		return 109, true
	case "f11":
		return 103, true
	case "f12":
		return 111, true
	}
	if len(name) == 1 {
		c := name[0]
		if c >= 'a' && c <= 'z' {
			letters := [26]uint16{
				0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6,
			}
			return letters[c-'a'], true
		}
		switch c {
		case '0':
			return 29, true
		case '1':
			return 18, true
		case '2':
			return 19, true
		case '3':
			return 20, true
		case '4':
			return 21, true
		case '5':
			return 23, true
		case '6':
			return 22, true
		case '7':
			return 26, true
		case '8':
			return 28, true
		case '9':
			return 25, true
		}
	}
	return 0, false
}
