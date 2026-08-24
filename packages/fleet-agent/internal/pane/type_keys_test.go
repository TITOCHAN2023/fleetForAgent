package pane

import (
	"bytes"
	"testing"
)

type writeLog struct {
	writes [][]byte
}

func (w *writeLog) Write(p []byte) (int, error) {
	w.writes = append(w.writes, append([]byte(nil), p...))
	return len(p), nil
}

func TestWriteTypedKeysSplitsTextAndCR(t *testing.T) {
	var w writeLog
	if err := writeTypedKeys(&w, []byte("hello\r")); err != nil {
		t.Fatal(err)
	}
	if len(w.writes) < 2 {
		t.Fatalf("want separate text and CR writes, got %#v", w.writes)
	}
	if !bytes.Equal(w.writes[0], []byte("hello")) || !bytes.Equal(w.writes[len(w.writes)-1], []byte{'\r'}) {
		t.Fatalf("writes=%#v", w.writes)
	}
}

func TestEncodeTypeEnterIsCR(t *testing.T) {
	for _, in := range []struct{ keys, named string }{
		{"", "enter"},
		{"enter", ""},
		{"\n", ""},
		{"\r", ""},
		{"hello\n", ""},
	} {
		s, err := encodeType(in.keys, in.named)
		if err != nil {
			t.Fatalf("%v: %v", in, err)
		}
		if !bytes.Contains(s.payload, []byte{'\r'}) {
			t.Fatalf("%v payload=%q want CR", in, s.payload)
		}
		if bytes.Contains(s.payload, []byte{'\n'}) {
			t.Fatalf("%v payload=%q still has LF", in, s.payload)
		}
	}
	s, err := encodeType("typed_ok\n", "")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(s.payload, []byte("typed_ok\r")) {
		t.Fatalf("typed_ok payload=%q", s.payload)
	}
}

func TestEncodeTypeCtrlC(t *testing.T) {
	s, err := encodeType("", "ctrl+c")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(s.payload, []byte{0x03}) || !s.sigint {
		t.Fatalf("ctrl+c: payload=%q sigint=%v", s.payload, s.sigint)
	}
	s, err = encodeType("ctrl+c", "")
	if err != nil || !bytes.Equal(s.payload, []byte{0x03}) || !s.sigint {
		t.Fatalf("keys ctrl+c: %+v err=%v", s, err)
	}
	s, err = encodeType("\x03", "")
	if err != nil || !s.sigint {
		t.Fatalf("raw 0x03: %+v err=%v", s, err)
	}
}

func TestEncodeTypeSSHPressTable(t *testing.T) {
	cases := []struct {
		spec string
		want []byte
	}{
		{"CTRL+C", []byte{0x03}},
		{"up", []byte("\x1b[A")},
		{"f5", []byte("\x1b[15~")},
		{"shift+tab", []byte("\x1b[Z")},
		{"alt+x", []byte("\x1bx")},
		{"ctrl+\\", []byte{0x1c}},
	}
	for _, tc := range cases {
		s, err := encodeType("", tc.spec)
		if err != nil {
			t.Fatalf("%s: %v", tc.spec, err)
		}
		if !bytes.Equal(s.payload, tc.want) {
			t.Fatalf("%s payload=%q want %q", tc.spec, s.payload, tc.want)
		}
	}
	s, err := encodeType("", "ctrl+\\")
	if err != nil || !s.sigquit {
		t.Fatalf("ctrl+\\ should request SIGQUIT: %+v err=%v", s, err)
	}
}
