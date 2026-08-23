package main

import (
	"path"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Always-blocked destructive verbs. rm -rf is handled separately so a
// precise absolute cleanup path is not blanket-banned.
var destructiveAlways = regexp.MustCompile(`(?i)(?:^|[\s;|&])(?:del\s+/f|format\s+c:|shutdown\b|reboot\b|mkfs\b|diskpart\b)`)

func devicePolicyBlocked(command string) bool {
	if destructiveAlways.MatchString(command) {
		return true
	}
	return rmRfBlocked(command)
}

func rmRfBlocked(command string) bool {
	for _, seg := range splitCommandSegments(command) {
		args := fieldsRespectingSimple(seg)
		args = stripSudoPrefix(args)
		if len(args) == 0 || args[0] != "rm" {
			continue
		}
		rf, paths := parseRmRf(args)
		if !rf {
			continue
		}
		if rmRfPathsDangerous(paths) {
			return true
		}
	}
	return false
}

func splitCommandSegments(s string) []string {
	var out []string
	var b strings.Builder
	var quote rune
	esc := false
	for _, r := range s {
		if esc {
			b.WriteRune(r)
			esc = false
			continue
		}
		if r == '\\' && quote != '\'' {
			b.WriteRune(r)
			esc = true
			continue
		}
		if quote != 0 {
			if r == quote {
				quote = 0
			}
			b.WriteRune(r)
			continue
		}
		if r == '\'' || r == '"' {
			quote = r
			b.WriteRune(r)
			continue
		}
		if r == ';' || r == '\n' || r == '|' || r == '&' {
			if seg := strings.TrimSpace(b.String()); seg != "" {
				out = append(out, seg)
			}
			b.Reset()
			continue
		}
		b.WriteRune(r)
	}
	if seg := strings.TrimSpace(b.String()); seg != "" {
		out = append(out, seg)
	}
	return out
}

func fieldsRespectingSimple(s string) []string {
	var out []string
	var b strings.Builder
	var quote rune
	for _, r := range s {
		if quote != 0 {
			if r == quote {
				quote = 0
				continue
			}
			b.WriteRune(r)
			continue
		}
		if r == '\'' || r == '"' {
			quote = r
			continue
		}
		if unicode.IsSpace(r) {
			if b.Len() > 0 {
				out = append(out, b.String())
				b.Reset()
			}
			continue
		}
		b.WriteRune(r)
	}
	if b.Len() > 0 {
		out = append(out, b.String())
	}
	return out
}

func stripSudoPrefix(args []string) []string {
	if len(args) == 0 {
		return args
	}
	if args[0] != "sudo" && args[0] != "doas" {
		return args
	}
	i := 1
	for i < len(args) && strings.HasPrefix(args[i], "-") {
		if args[i] == "--" {
			i++
			break
		}
		i++
	}
	return args[i:]
}

func parseRmRf(args []string) (is bool, paths []string) {
	if len(args) == 0 || args[0] != "rm" {
		return false, nil
	}
	recursive, force := false, false
	dashdash := false
	for _, a := range args[1:] {
		if dashdash {
			paths = append(paths, a)
			continue
		}
		if a == "--" {
			dashdash = true
			continue
		}
		if a == "--recursive" {
			recursive = true
			continue
		}
		if a == "--force" {
			force = true
			continue
		}
		if strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") {
			if strings.ContainsAny(a, "rR") {
				recursive = true
			}
			if strings.Contains(a, "f") {
				force = true
			}
			continue
		}
		paths = append(paths, a)
	}
	return recursive && force, paths
}

func rmRfPathsDangerous(paths []string) bool {
	if len(paths) == 0 {
		return true
	}
	for _, p := range paths {
		if !safeCleanupPath(p) {
			return true
		}
	}
	return false
}

// safeCleanupPath allows rm -rf of a specific absolute path with at least
// two components (/tmp/cleanup). Root, home, relative, and glob targets stay blocked.
func safeCleanupPath(p string) bool {
	p = strings.TrimSpace(p)
	if p == "" {
		return false
	}
	if strings.ContainsAny(p, "*?[") {
		return false
	}
	if p == "~" || strings.HasPrefix(p, "~/") || p == "$HOME" || strings.HasPrefix(p, "$HOME/") {
		return false
	}
	if strings.HasPrefix(p, "/") {
		cleaned := path.Clean(p)
		if cleaned == "/" {
			return false
		}
		rel := strings.TrimPrefix(cleaned, "/")
		return rel != "" && strings.Contains(rel, "/")
	}
	if winAbsTwoComponents(p) {
		return true
	}
	return false
}

func winAbsTwoComponents(p string) bool {
	if len(p) < 3 {
		return false
	}
	r, _ := utf8.DecodeRuneInString(p)
	if !unicode.IsLetter(r) || p[1] != ':' {
		return false
	}
	if p[2] != '\\' && p[2] != '/' {
		return false
	}
	rest := strings.TrimLeft(p[2:], `/\`)
	if rest == "" || strings.ContainsAny(rest, "*?") {
		return false
	}
	return strings.ContainsAny(rest, `/\`)
}
