package pane

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
	"unicode/utf8"
)

// Split text and CR so the slave sees Enter.
const typeEnterSettle = 40 * time.Millisecond

// Named keys plus Enter aliases. SIGINT goes to the fg pgid; byte 0x03 is not enough on this PTY.

type typeStroke struct {
	payload []byte
	sigint  bool
	sigquit bool
}

func encodeType(keys, named string) (typeStroke, error) {
	if spec := strings.TrimSpace(named); spec != "" {
		s, ok := mapNamedKey(spec)
		if !ok {
			return typeStroke{}, fmt.Errorf("unknown key %q", named)
		}
		return withSignals(s), nil
	}
	if isKeySpec(keys) {
		if s, ok := mapNamedKey(keys); ok {
			return withSignals(s), nil
		}
	}
	return withSignals(typeStroke{payload: liveEnterBytes(keys)}), nil
}

func isKeySpec(keys string) bool {
	if keys == "\n" || keys == "\r" || keys == "\r\n" {
		return true
	}
	s := strings.TrimSpace(keys)
	if s == "" {
		return false
	}
	if _, ok := namedKeyBytes(strings.ToLower(s)); ok {
		return true
	}
	if strings.Contains(s, "+") {
		return true
	}
	return len(s) == 1 && s[0] == 0x03
}

func liveEnterBytes(keys string) []byte {
	s := strings.ReplaceAll(keys, "\r\n", "\r")
	s = strings.ReplaceAll(s, "\n", "\r")
	return []byte(s)
}

func writeTypedKeys(w io.Writer, payload []byte) error {
	if w == nil {
		return io.ErrClosedPipe
	}
	for len(payload) > 0 {
		i := bytes.IndexByte(payload, '\r')
		if i < 0 {
			_, err := w.Write(payload)
			return err
		}
		if i > 0 {
			if _, err := w.Write(payload[:i]); err != nil {
				return err
			}
			if f, ok := w.(*os.File); ok {
				_ = f.Sync()
			}
			time.Sleep(typeEnterSettle)
		}
		if _, err := w.Write([]byte{'\r'}); err != nil {
			return err
		}
		payload = payload[i+1:]
	}
	return nil
}

func withSignals(s typeStroke) typeStroke {
	if bytes.Contains(s.payload, []byte{0x03}) {
		s.sigint = true
	}
	if bytes.Contains(s.payload, []byte{0x1c}) {
		s.sigquit = true
	}
	return s
}

func mapNamedKey(spec string) (typeStroke, bool) {
	if spec == "" {
		return typeStroke{}, false
	}
	if spec == "\n" || spec == "\r" || spec == "\r\n" {
		return typeStroke{payload: []byte{'\r'}}, true
	}
	lower := strings.ToLower(strings.TrimSpace(spec))
	if lower == "" {
		return typeStroke{}, false
	}
	if lower == "ctrl+\\" || lower == "ctrl+\\\\" {
		return typeStroke{payload: []byte{0x1c}}, true
	}
	parts := strings.Split(lower, "+")
	base := parts[len(parts)-1]
	mods := parts[:len(parts)-1]
	if base == "" {
		return typeStroke{}, false
	}
	var ctrl, alt, shift bool
	for _, m := range mods {
		switch m {
		case "ctrl":
			if ctrl {
				return typeStroke{}, false
			}
			ctrl = true
		case "alt":
			if alt {
				return typeStroke{}, false
			}
			alt = true
		case "shift":
			if shift {
				return typeStroke{}, false
			}
			shift = true
		default:
			return typeStroke{}, false
		}
	}
	if seq, ok := namedKeyBytes(base); ok {
		if shift && base == "tab" && !ctrl && !alt {
			return typeStroke{payload: []byte("\x1b[Z")}, true
		}
		if ctrl || alt || shift {
			return typeStroke{}, false
		}
		return typeStroke{payload: append([]byte{}, seq...)}, true
	}
	r, size := utf8.DecodeRuneInString(base)
	if r == utf8.RuneError || size != len(base) {
		return typeStroke{}, false
	}
	if r == '\n' || r == '\r' {
		return typeStroke{payload: []byte{'\r'}}, true
	}
	var out []byte
	if alt {
		out = append(out, 0x1b)
	}
	if ctrl {
		if r < 'A' || (r > 'Z' && r < 'a') || r > 'z' {
			if r == '\\' {
				return typeStroke{payload: append(out, 0x1c)}, true
			}
			return typeStroke{}, false
		}
		out = append(out, byte(r)&0x1f)
		return typeStroke{payload: out}, true
	}
	if shift {
		out = append(out, []byte(strings.ToUpper(string(r)))...)
		return typeStroke{payload: out}, true
	}
	out = append(out, byte(r))
	return typeStroke{payload: out}, true
}

func namedKeyBytes(name string) ([]byte, bool) {
	switch name {
	case "enter", "return":
		return []byte{'\r'}, true
	case "esc", "escape":
		return []byte{0x1b}, true
	case "tab":
		return []byte{'\t'}, true
	case "backspace":
		return []byte{0x7f}, true
	case "space":
		return []byte{' '}, true
	case "delete":
		return []byte("\x1b[3~"), true
	case "insert":
		return []byte("\x1b[2~"), true
	case "home":
		return []byte("\x1b[H"), true
	case "end":
		return []byte("\x1b[F"), true
	case "pgup", "pageup":
		return []byte("\x1b[5~"), true
	case "pgdn", "pagedown":
		return []byte("\x1b[6~"), true
	case "up":
		return []byte("\x1b[A"), true
	case "down":
		return []byte("\x1b[B"), true
	case "right":
		return []byte("\x1b[C"), true
	case "left":
		return []byte("\x1b[D"), true
	case "f1":
		return []byte("\x1bOP"), true
	case "f2":
		return []byte("\x1bOQ"), true
	case "f3":
		return []byte("\x1bOR"), true
	case "f4":
		return []byte("\x1bOS"), true
	case "f5":
		return []byte("\x1b[15~"), true
	case "f6":
		return []byte("\x1b[17~"), true
	case "f7":
		return []byte("\x1b[18~"), true
	case "f8":
		return []byte("\x1b[19~"), true
	case "f9":
		return []byte("\x1b[20~"), true
	case "f10":
		return []byte("\x1b[21~"), true
	case "f11":
		return []byte("\x1b[23~"), true
	case "f12":
		return []byte("\x1b[24~"), true
	default:
		return nil, false
	}
}
