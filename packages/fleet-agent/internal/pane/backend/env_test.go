package backend

import "testing"

func TestDropMuxClientEnv(t *testing.T) {
	in := []string{
		"PATH=/bin",
		"TMUX=/tmp/tmux-1000/default,1,0",
		"TMUX_PANE=%0",
		"ZELLIJ=0",
		"HOME=/tmp",
	}
	got := dropMuxClientEnv(in)
	want := map[string]bool{"PATH=/bin": true, "HOME=/tmp": true}
	if len(got) != 2 {
		t.Fatalf("got %q", got)
	}
	for _, e := range got {
		if !want[e] {
			t.Fatalf("unexpected %q", e)
		}
	}
}

func TestRequestedEnv(t *testing.T) {
	t.Setenv(EnvVar, "pty")
	if Requested() != TypePTY {
		t.Fatalf("got %q", Requested())
	}
	t.Setenv(EnvVar, "")
	if Requested() != TypeTmux {
		t.Fatalf("default %q", Requested())
	}
}
