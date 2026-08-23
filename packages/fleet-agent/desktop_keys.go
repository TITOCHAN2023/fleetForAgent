package main

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
