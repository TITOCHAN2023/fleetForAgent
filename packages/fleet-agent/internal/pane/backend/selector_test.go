package backend

import (
	"strings"
	"testing"
)

func TestParseType(t *testing.T) {
	cases := map[string]Type{
		"":         TypeTmux,
		"tmux":     TypeTmux,
		"PTY":      TypePTY,
		"zellij":   TypeZellij,
		"unknown":  TypeTmux,
		"  tmux  ": TypeTmux,
	}
	for in, want := range cases {
		if got := ParseType(in); got != want {
			t.Fatalf("ParseType(%q)=%q want %q", in, got, want)
		}
	}
}

func TestDecideGate(t *testing.T) {
	t.Run("pty always spawns", func(t *testing.T) {
		g := DecideGate(TypePTY, false, false, false)
		if g.Action != GateSpawn {
			t.Fatalf("%+v", g)
		}
	})
	t.Run("missing mux hard-gates", func(t *testing.T) {
		g := DecideGate(TypeTmux, false, false, false)
		if g.Action != GateRefuse {
			t.Fatalf("%+v", g)
		}
	})
	t.Run("existing session reattaches despite probe miss", func(t *testing.T) {
		g := DecideGate(TypeTmux, false, true, false)
		if g.Action != GateSpawn {
			t.Fatalf("%+v", g)
		}
	})
	t.Run("unknown existence still spawns", func(t *testing.T) {
		g := DecideGate(TypeZellij, false, false, true)
		if g.Action != GateSpawn {
			t.Fatalf("%+v", g)
		}
	})
	t.Run("available mux spawns", func(t *testing.T) {
		g := DecideGate(TypeTmux, true, false, false)
		if g.Action != GateSpawn {
			t.Fatalf("%+v", g)
		}
	})
}

func TestSessionNameSanitizes(t *testing.T) {
	if got := SessionName(""); got != "flt-anon" {
		t.Fatalf("empty: %q", got)
	}
	if got := SessionName("fp:a/b.c"); got != "flt-fp-a-b-c" {
		t.Fatalf("punct: %q", got)
	}
	long := SessionName(strings.Repeat("x", 80))
	if !strings.HasPrefix(long, "flt-") || len(long) > 4+24 {
		t.Fatalf("long: %q", long)
	}
}

func TestGateErrorMentionsPtyEscape(t *testing.T) {
	msg := (&GateError{Type: TypeTmux, Reason: "not installed"}).UserMessage()
	if !strings.Contains(msg, EnvVar+"=pty") || !strings.Contains(msg, "brew install tmux") {
		t.Fatalf("hint: %q", msg)
	}
}
