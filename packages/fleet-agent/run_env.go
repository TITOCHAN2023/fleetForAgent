package main

import (
	"os"
	"regexp"
	"strings"
)

var (
	probeOSC11 = regexp.MustCompile(`\x1b\]11;\?(?:\x07|\x1b\\)|\]11;\?`)
	probeCSIn  = regexp.MustCompile(`\x1b\[\d*n|\[6n`)
)

func runCommandEnv() []string {
	out := make([]string, 0, len(os.Environ())+8)
	for _, e := range os.Environ() {
		switch {
		case strings.HasPrefix(e, "TERM="),
			strings.HasPrefix(e, "NO_COLOR="),
			strings.HasPrefix(e, "FORCE_COLOR="),
			strings.HasPrefix(e, "PAGER="),
			strings.HasPrefix(e, "GIT_PAGER="),
			strings.HasPrefix(e, "LANG="),
			strings.HasPrefix(e, "LC_ALL="),
			strings.HasPrefix(e, "LC_CTYPE="):
			continue
		}
		out = append(out, e)
	}
	return append(out,
		"TERM=xterm-256color",
		"PAGER=cat",
		"GIT_PAGER=cat",
		"LANG=C.UTF-8",
		"LC_ALL=C.UTF-8",
	)
}

func stripProbeSequences(s string) string {
	if s == "" {
		return s
	}
	s = probeOSC11.ReplaceAllString(s, "")
	s = probeCSIn.ReplaceAllString(s, "")
	return s
}

func stripRunOutput(s string) string {
	return stripProbeSequences(stripCompletionText(s))
}
