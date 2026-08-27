package policy

import (
	"path"
	"strings"
	"unicode"
	"unicode/utf8"
)

func Blocked(command string) bool {
	return blocked(command, 0)
}

func blocked(command string, depth int) bool {
	if depth > 3 {
		return true
	}
	for _, seg := range splitCommandSegments(command) {
		args := normalizeCommand(fieldsRespectingSimple(seg))
		if len(args) == 0 {
			continue
		}
		if body, ok := nestedShellBody(args); ok {
			if blocked(body, depth+1) {
				return true
			}
			continue
		}
		if destructiveVerbBlocked(args) {
			return true
		}
		if commandBase(args[0]) != "rm" {
			continue
		}
		rf, paths := parseRmRf(args)
		if rf && rmRfPathsDangerous(paths) {
			return true
		}
	}
	return false
}

func nestedShellBody(args []string) (string, bool) {
	if len(args) < 3 {
		return "", false
	}
	switch commandBase(args[0]) {
	case "sh", "bash", "dash", "zsh", "ksh":
		for i := 1; i < len(args)-1; i++ {
			arg := strings.ToLower(args[i])
			if arg == "-c" || (strings.HasPrefix(arg, "-") && !strings.HasPrefix(arg, "--") && strings.Contains(arg[1:], "c")) {
				return strings.Join(args[i+1:], " "), true
			}
			if !strings.HasPrefix(arg, "-") {
				break
			}
			if shellOptionTakesValue(arg) {
				i++
			}
		}
	case "cmd":
		for i := 1; i < len(args)-1; i++ {
			if strings.EqualFold(args[i], "/c") || strings.EqualFold(args[i], "/k") {
				return strings.Join(args[i+1:], " "), true
			}
		}
	case "powershell", "pwsh":
		for i := 1; i < len(args)-1; i++ {
			if strings.EqualFold(args[i], "-command") || strings.EqualFold(args[i], "-c") {
				return strings.Join(args[i+1:], " "), true
			}
		}
	}
	return "", false
}

func shellOptionTakesValue(option string) bool {
	switch option {
	case "-o", "-O", "--rcfile", "--init-file":
		return true
	}
	return false
}

func destructiveVerbBlocked(args []string) bool {
	base := commandBase(args[0])
	if base == "powershell" || base == "pwsh" {
		for _, arg := range args[1:] {
			if strings.EqualFold(arg, "-encodedcommand") || strings.EqualFold(arg, "-enc") {
				return true
			}
		}
	}
	switch base {
	case "shutdown", "reboot", "halt", "poweroff", "diskpart":
		return true
	case "format":
		return len(args) > 1 && strings.HasSuffix(strings.ToLower(strings.TrimSpace(args[1])), ":")
	case "del":
		for _, arg := range args[1:] {
			if strings.Contains(strings.ToLower(arg), "/f") {
				return true
			}
		}
	case "rd", "rmdir", "remove-item":
		recursive, force, paths := destructiveRemoveArgs(args[1:])
		return recursive && force && rmRfPathsDangerous(paths)
	}
	return base == "mkfs" || strings.HasPrefix(base, "mkfs.")
}

func destructiveRemoveArgs(args []string) (recursive bool, force bool, paths []string) {
	for _, arg := range args {
		switch strings.ToLower(arg) {
		case "/s", "-r", "-recurse", "-recursive":
			recursive = true
		case "/q", "-f", "-force":
			force = true
		default:
			if (!strings.HasPrefix(arg, "-") && !strings.HasPrefix(arg, "/")) || isAbsPath(arg) {
				paths = append(paths, arg)
			}
		}
	}
	return recursive, force, paths
}

func isAbsPath(value string) bool {
	return strings.HasPrefix(value, "/") || winAbsPath(value)
}

func winAbsPath(value string) bool {
	if len(value) < 3 {
		return false
	}
	r, _ := utf8.DecodeRuneInString(value)
	return unicode.IsLetter(r) && value[1] == ':' && (value[2] == '\\' || value[2] == '/')
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
	if commandBase(args[0]) != "sudo" && commandBase(args[0]) != "doas" {
		return args
	}
	i := 1
	for i < len(args) {
		option := args[i]
		if option == "--" {
			i++
			break
		}
		if !strings.HasPrefix(option, "-") {
			break
		}
		i++
		if sudoOptionTakesValue(option) && i < len(args) {
			i++
		}
	}
	return args[i:]
}

func sudoOptionTakesValue(option string) bool {
	if strings.Contains(option, "=") || (len(option) > 2 && !strings.HasPrefix(option, "--")) {
		return false
	}
	switch option {
	case "-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "--user", "--group", "--host", "--prompt", "--chdir", "--close-from":
		return true
	}
	return false
}

func normalizeCommand(args []string) []string {
	args = stripSudoPrefix(args)
	for len(args) > 0 {
		switch commandBase(args[0]) {
		case "command":
			args = args[1:]
			for len(args) > 0 && strings.HasPrefix(args[0], "-") {
				args = args[1:]
			}
		case "env":
			args = stripEnvPrefix(args)
		case "busybox":
			args = args[1:]
			for len(args) > 0 && strings.HasPrefix(args[0], "-") {
				args = args[1:]
			}
		default:
			return args
		}
	}
	return args
}

func stripEnvPrefix(args []string) []string {
	args = args[1:]
	for len(args) > 0 {
		arg := args[0]
		if arg == "--" {
			return args[1:]
		}
		if strings.Contains(arg, "=") && !strings.HasPrefix(arg, "-") {
			args = args[1:]
			continue
		}
		if !strings.HasPrefix(arg, "-") {
			return args
		}
		args = args[1:]
		if envOptionTakesValue(arg) && !strings.Contains(arg, "=") && len(args) > 0 {
			args = args[1:]
		}
	}
	return args
}

func envOptionTakesValue(option string) bool {
	switch option {
	case "-u", "--unset", "-C", "--chdir", "-S", "--split-string":
		return true
	}
	return false
}

func commandBase(s string) string {
	s = strings.ReplaceAll(strings.TrimSpace(s), `\`, "/")
	base := strings.ToLower(path.Base(s))
	base = strings.TrimSuffix(base, ".exe")
	return strings.TrimSuffix(base, ".com")
}

func parseRmRf(args []string) (is bool, paths []string) {
	if len(args) == 0 || commandBase(args[0]) != "rm" {
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
		if a == "--recursive" || strings.EqualFold(a, "-recurse") || strings.EqualFold(a, "-recursive") {
			recursive = true
			continue
		}
		if a == "--force" || strings.EqualFold(a, "-force") {
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
	normalized := strings.ReplaceAll(p[2:], `\`, "/")
	cleaned := path.Clean("/" + strings.TrimLeft(normalized, "/"))
	if cleaned == "/" || strings.ContainsAny(cleaned, "*?[") {
		return false
	}
	rest := strings.TrimPrefix(cleaned, "/")
	return rest != "" && strings.Contains(rest, "/")
}
