//go:build !windows

package backend

import (
	"strings"
	"testing"
)

func TestKdlStringEscapes(t *testing.T) {
	got := kdlString(`a"b\c`)
	if got != `"a\"b\\c"` {
		t.Fatalf("%s", got)
	}
}

func TestZellijLayoutEmptyArgs(t *testing.T) {
	s := zellijLayout(SpawnOpts{Bin: "/bin/sh"})
	for _, part := range []string{"layout {", `command="/bin/sh"`, "close_on_exit=true"} {
		if !strings.Contains(s, part) {
			t.Fatalf("missing %q in %s", part, s)
		}
	}
}
