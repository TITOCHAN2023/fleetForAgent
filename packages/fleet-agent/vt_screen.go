package main

import (
	"io"
	"strings"

	"github.com/hinshun/vt10x"
)

const (
	livePtyRows = 40
	livePtyCols = 120
)

// VT102 primary DA. vt10x's CSI 'c' handler is a TODO and does not write.
const daPrimary = "\x1b[?1;2c"

type vtScreen struct {
	term    vt10x.Terminal
	pending []byte
	replies io.Writer
}

func newVTScreen(cols, rows int, replies io.Writer) *vtScreen {
	if cols <= 0 {
		cols = livePtyCols
	}
	if rows <= 0 {
		rows = livePtyRows
	}
	if replies == nil {
		replies = io.Discard
	}
	return &vtScreen{
		term:    vt10x.New(vt10x.WithSize(cols, rows), vt10x.WithWriter(replies)),
		replies: replies,
	}
}

func (s *vtScreen) write(p []byte) {
	if s == nil || s.term == nil || len(p) == 0 {
		return
	}
	_, _ = s.term.Write(p)
	for _, reply := range s.consumeQueries(p) {
		_, _ = s.replies.Write(reply)
	}
}

// consumeQueries answers DA written by the slave. DSR/CPR stay with vt10x
// (CSI 5n / CSI 6n write through WithWriter). This is not a render parser.
func (s *vtScreen) consumeQueries(p []byte) [][]byte {
	buf := append(s.pending, p...)
	s.pending = nil
	var replies [][]byte
	i := 0
	for i < len(buf) {
		if buf[i] != 0x1b {
			i++
			continue
		}
		if i+1 >= len(buf) {
			s.pending = append([]byte{}, buf[i:]...)
			break
		}
		if buf[i+1] != '[' {
			i++
			continue
		}
		j := i + 2
		for j < len(buf) && (buf[j] < 0x40 || buf[j] > 0x7e) {
			j++
		}
		if j >= len(buf) {
			s.pending = append([]byte{}, buf[i:]...)
			break
		}
		if buf[j] == 'c' {
			replies = append(replies, []byte(daPrimary))
		}
		i = j + 1
	}
	return replies
}

// leaveAlt switches the emulator back to the primary screen. A TUI that
// exits without CSI ?1049l leaves the last box on the alt buffer; the
// live-shell PS1 is what a human sees after that.
func (s *vtScreen) leaveAlt() {
	if s == nil || s.term == nil {
		return
	}
	if s.term.Mode()&vt10x.ModeAltScreen == 0 {
		return
	}
	_, _ = s.term.Write([]byte("\x1b[?1049l"))
	if s.term.Mode()&vt10x.ModeAltScreen != 0 {
		_, _ = s.term.Write([]byte("\x1b[?47l"))
	}
}

func (s *vtScreen) grid() (text string, row, col int) {
	if s == nil || s.term == nil {
		return "", 0, 0
	}
	s.term.Lock()
	defer s.term.Unlock()
	cols, rows := s.term.Size()
	cur := s.term.Cursor()
	lines := make([]string, rows)
	last := -1
	for y := 0; y < rows; y++ {
		runes := make([]rune, cols)
		for x := 0; x < cols; x++ {
			ch := s.term.Cell(x, y).Char
			if ch == 0 {
				ch = ' '
			}
			runes[x] = ch
		}
		line := strings.TrimRight(string(runes), " ")
		lines[y] = line
		if line != "" {
			last = y
		}
	}
	if last < 0 {
		return "", cur.Y, cur.X
	}
	return strings.Join(lines[:last+1], "\n"), cur.Y, cur.X
}
