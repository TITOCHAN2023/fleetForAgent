package policy

import (
	"encoding/base64"
	"strings"
	"unicode"
	"unicode/utf8"
)

const restoreDepth = 32
const restorePeels = 8

func unfoldAll(command string) (string, bool, bool) {
	current := command
	changed := false
	for i := 0; i < restorePeels; i++ {
		next, ok, refuse := unfoldOnce(current, restorePeels-i)
		if refuse {
			if ok {
				return next, true, true
			}
			return current, changed, true
		}
		if !ok {
			return current, changed, false
		}
		current = next
		changed = true
	}
	_, again, refuse := unfoldOnce(current, 0)
	return current, changed, refuse || again
}

func unfoldOnce(command string, peels int) (string, bool, bool) {
	stripped := stripComments(command)
	withSubs, subOK, refuse := expandSubstitutions(stripped, 0, peels)
	if refuse {
		return withSubs, subOK, true
	}
	withPipes, pipeOK := expandDecodePipes(withSubs)
	if !subOK && !pipeOK {
		return "", false, false
	}
	result := withSubs
	if pipeOK {
		result = withPipes
	}
	if result == command {
		return "", false, false
	}
	return result, true, false
}

func expandDecodePipes(command string) (string, bool) {
	parts := splitStatements(command)
	changed := false
	for i, part := range parts {
		decoded, ok := decodePipe(part)
		if !ok {
			continue
		}
		parts[i] = decoded
		changed = true
	}
	if !changed {
		return command, false
	}
	kept := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			kept = append(kept, part)
		}
	}
	return strings.Join(kept, "; "), true
}

func decodePipe(statement string) (string, bool) {
	stages := splitPipes(statement)
	clean := make([]string, 0, len(stages))
	for _, stage := range stages {
		if strings.TrimSpace(stage) != "" {
			clean = append(clean, stage)
		}
	}
	var scripts []string
	for i := 0; i+2 < len(clean); {
		payload, ok := producerPayload(clean[i])
		if !ok || !isBase64Decode(clean[i+1]) || !isStdinShell(clean[i+2]) {
			i++
			continue
		}
		decoded, ok := decodeBase64(payload)
		if !ok {
			i++
			continue
		}
		scripts = append(scripts, strings.TrimRight(decoded, "\n"))
		i += 3
	}
	if len(scripts) == 0 {
		return "", false
	}
	return strings.Join(scripts, "; "), true
}

func producerPayload(seg string) (string, bool) {
	args, ok := commandWords(seg)
	if !ok {
		return "", false
	}
	switch commandBase(args[0]) {
	case "echo":
		rest := echoArgs(args[1:])
		if len(rest) == 1 && plainLiteral(rest[0]) {
			return rest[0], true
		}
	case "printf":
		if len(args) == 2 && plainLiteral(args[1]) && !strings.Contains(args[1], "%") {
			return args[1], true
		}
		if len(args) == 3 && plainStringFormat(args[1]) && plainLiteral(args[2]) {
			return args[2], true
		}
	}
	return "", false
}

func producerStdout(seg string) (string, bool) {
	args, ok := commandWords(seg)
	if !ok {
		return "", false
	}
	if commandBase(args[0]) != "echo" {
		return producerPayload(seg)
	}
	rest := echoArgs(args[1:])
	if len(rest) == 0 {
		return "", false
	}
	for _, arg := range rest {
		if !plainLiteral(arg) {
			return "", false
		}
	}
	return strings.Join(rest, " "), true
}

func echoArgs(args []string) []string {
	if len(args) > 0 && args[0] == "-n" {
		return args[1:]
	}
	return args
}

func plainLiteral(s string) bool {
	return s != "" && !strings.ContainsAny(s, "$`")
}

func plainStringFormat(s string) bool {
	switch s {
	case "%s", `%s\n`, "%s\n":
		return true
	default:
		return false
	}
}

func isBase64Decode(seg string) bool {
	args, ok := commandWords(seg)
	if !ok || commandBase(args[0]) != "base64" {
		return false
	}
	decode := false
	for i := 1; i < len(args); i++ {
		a := args[i]
		lower := strings.ToLower(a)
		switch lower {
		case "--decode":
			decode = true
			continue
		case "-i", "--ignore-garbage":
			continue
		case "-w", "--wrap":
			if i+1 >= len(args) {
				return false
			}
			i++
			continue
		}
		if strings.HasPrefix(lower, "--wrap=") {
			continue
		}
		if len(a) > 1 && a[0] == '-' && a[1] != '-' {
			for j := 1; j < len(a); j++ {
				switch a[j] {
				case 'd', 'D':
					decode = true
				case 'i':
				case 'w':
					if j+1 == len(a) {
						if i+1 >= len(args) {
							return false
						}
						i++
					}
					j = len(a)
				default:
					return false
				}
			}
			continue
		}
		return false
	}
	return decode
}

func isStdinShell(seg string) bool {
	args, ok := commandWords(seg)
	if !ok {
		return false
	}
	switch commandBase(args[0]) {
	case "sh", "bash", "dash", "zsh", "ksh":
	default:
		return false
	}
	for i := 1; i < len(args); i++ {
		arg := args[i]
		if next, redir := redirection(arg); redir {
			if next {
				if i+1 >= len(args) {
					return false
				}
				i++
			}
			continue
		}
		if arg == "--" || arg == "-s" || arg == "--stdin" || arg == "--posix" || arg == "--norc" || arg == "--noprofile" || arg == "--login" {
			continue
		}
		if shellOptionTakesValue(arg) {
			if i+1 >= len(args) {
				return false
			}
			i++
			continue
		}
		if strings.HasPrefix(arg, "-") && !strings.HasPrefix(arg, "--") && !strings.ContainsAny(arg, "cC") {
			continue
		}
		return false
	}
	return true
}

func redirection(arg string) (consumeNext bool, ok bool) {
	if arg == "" || !strings.ContainsAny(arg, "<>") {
		return false, false
	}
	if strings.HasPrefix(arg, "-") && !strings.Contains(arg, ">") {
		return false, false
	}
	if strings.HasSuffix(arg, ">") || strings.HasSuffix(arg, "<") {
		return true, true
	}
	return false, true
}

func commandWords(seg string) ([]string, bool) {
	args := normalizeCommand(fieldsRespectingSimple(strings.TrimSpace(seg)))
	if len(args) == 0 {
		return nil, false
	}
	return args, true
}

func decodeBase64(s string) (string, bool) {
	clean := strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return -1
		}
		return r
	}, strings.TrimSpace(s))
	if clean == "" {
		return "", false
	}
	if pad := len(clean) % 4; pad != 0 {
		clean += strings.Repeat("=", 4-pad)
	}
	raw, err := base64.StdEncoding.DecodeString(clean)
	if err != nil || strings.IndexByte(string(raw), 0) >= 0 || !utf8.Valid(raw) {
		return "", false
	}
	return string(raw), true
}

func substitutionOutput(body string) (string, bool) {
	stages := splitPipes(body)
	clean := make([]string, 0, len(stages))
	for _, stage := range stages {
		if strings.TrimSpace(stage) != "" {
			clean = append(clean, stage)
		}
	}
	switch len(clean) {
	case 1:
		return producerStdout(clean[0])
	case 2:
		if !isBase64Decode(clean[1]) {
			return "", false
		}
		payload, ok := producerPayload(clean[0])
		if !ok {
			return "", false
		}
		return decodeBase64(payload)
	default:
		return "", false
	}
}

func restoredRefuses(script string, peels int) bool {
	if blocked(script, 0) {
		return true
	}
	if peels <= 0 {
		if _, ok := expandDecodePipes(script); ok {
			return true
		}
		return strings.Contains(script, "$(") || strings.Contains(script, "`")
	}
	next, ok, refuse := unfoldOnce(script, peels)
	if refuse {
		return true
	}
	if !ok {
		return false
	}
	return restoredRefuses(next, peels-1)
}

func expandSubstitutions(s string, depth, peels int) (string, bool, bool) {
	if depth > restoreDepth {
		return s, false, true
	}
	var b strings.Builder
	changed := false
	quote := rune(0)
	esc := false
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		if esc {
			b.WriteRune(r)
			esc = false
			i += size
			continue
		}
		if r == '\\' && quote != '\'' {
			b.WriteRune(r)
			esc = true
			i += size
			continue
		}
		if quote != 0 && r == quote {
			quote = 0
			b.WriteRune(r)
			i += size
			continue
		}
		if quote == 0 && (r == '\'' || r == '"') {
			quote = r
			b.WriteRune(r)
			i += size
			continue
		}
		if quote != '\'' && (strings.HasPrefix(s[i:], "$(") || r == '`') {
			body, end, found := findSubst(s, i)
			if !found {
				b.WriteRune(r)
				i += size
				continue
			}
			inner, _, refuse := expandSubstitutions(body, depth+1, peels)
			if refuse {
				return inner, true, true
			}
			if script, ran := expandDecodePipes(inner); ran {
				if restoredRefuses(script, peels-1) {
					return script, true, true
				}
				b.WriteString(s[i:end])
				i = end
				continue
			}
			out, ok := substitutionOutput(inner)
			if !ok || !writeExpansion(&b, out, quote == '"') {
				b.WriteString(s[i:end])
				i = end
				continue
			}
			changed = true
			i = end
			continue
		}
		b.WriteRune(r)
		i += size
	}
	return b.String(), changed, false
}

func writeExpansion(b *strings.Builder, out string, inDouble bool) bool {
	out = strings.TrimRight(out, "\n")
	if inDouble {
		if strings.Contains(out, "$(") || strings.ContainsAny(out, "\"\\`") {
			return false
		}
		b.WriteString(out)
		return true
	}
	b.WriteString(spliceFields(out))
	return true
}

func spliceFields(out string) string {
	words := strings.FieldsFunc(out, func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\n' || r == '\r'
	})
	if len(words) == 0 {
		return ""
	}
	quoted := make([]string, len(words))
	for i, word := range words {
		quoted[i] = quoteWord(word)
	}
	return strings.Join(quoted, " ")
}

func quoteWord(w string) string {
	var b strings.Builder
	b.WriteByte('\'')
	for i := 0; i < len(w); i++ {
		if w[i] == '\'' {
			b.WriteString(`'"'"'`)
			continue
		}
		b.WriteByte(w[i])
	}
	b.WriteByte('\'')
	return b.String()
}

func findSubst(s string, i int) (body string, end int, ok bool) {
	if strings.HasPrefix(s[i:], "$(") {
		return commandSubst(s, i)
	}
	if i < len(s) && s[i] == '`' {
		return backtickSubst(s, i)
	}
	return "", 0, false
}

func commandSubst(s string, dollar int) (body string, end int, ok bool) {
	if !strings.HasPrefix(s[dollar:], "$(") {
		return "", 0, false
	}
	i := dollar + 2
	depth := 1
	quote := rune(0)
	esc := false
	for i < len(s) {
		r, size := utf8.DecodeRuneInString(s[i:])
		if esc {
			esc = false
			i += size
			continue
		}
		if r == '\\' && quote != '\'' {
			esc = true
			i += size
			continue
		}
		if quote != 0 {
			if r == quote {
				quote = 0
			}
			i += size
			continue
		}
		if r == '\'' || r == '"' {
			quote = r
			i += size
			continue
		}
		if r == '(' {
			depth++
		} else if r == ')' {
			depth--
			if depth == 0 {
				return s[dollar+2 : i], i + size, true
			}
		}
		i += size
	}
	return "", 0, false
}

func backtickSubst(s string, at int) (body string, end int, ok bool) {
	j := at + 1
	for j < len(s) {
		if s[j] == '\\' && j+1 < len(s) {
			j += 2
			continue
		}
		if s[j] == '`' {
			return s[at+1 : j], j + 1, true
		}
		j++
	}
	return "", 0, false
}

func stripComments(s string) string {
	var b strings.Builder
	quote := rune(0)
	esc := false
	word := true
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		if esc {
			b.WriteRune(r)
			esc = false
			word = false
			i += size
			continue
		}
		if r == '\\' && quote != '\'' {
			b.WriteRune(r)
			esc = true
			i += size
			continue
		}
		if quote != 0 {
			if r == quote {
				quote = 0
			}
			b.WriteRune(r)
			word = false
			i += size
			continue
		}
		if r == '\'' || r == '"' {
			quote = r
			b.WriteRune(r)
			word = false
			i += size
			continue
		}
		if r == '#' && word {
			for i < len(s) && s[i] != '\n' {
				_, n := utf8.DecodeRuneInString(s[i:])
				i += n
			}
			word = true
			continue
		}
		word = r == '\n' || unicode.IsSpace(r)
		b.WriteRune(r)
		i += size
	}
	return b.String()
}

type splitKind int

const (
	splitStatement splitKind = iota
	splitPipe
)

func splitStatements(s string) []string { return splitShell(s, splitStatement) }
func splitPipes(s string) []string      { return splitShell(s, splitPipe) }

func splitShell(s string, kind splitKind) []string {
	var out []string
	var b strings.Builder
	quote := rune(0)
	esc := false
	flush := func() {
		out = append(out, b.String())
		b.Reset()
	}
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		if esc {
			b.WriteRune(r)
			esc = false
			i += size
			continue
		}
		if r == '\\' && quote != '\'' {
			b.WriteRune(r)
			esc = true
			i += size
			continue
		}
		if quote != 0 {
			if r == quote {
				quote = 0
			}
			b.WriteRune(r)
			i += size
			continue
		}
		if r == '\'' || r == '"' {
			quote = r
			b.WriteRune(r)
			i += size
			continue
		}
		if r == '`' || strings.HasPrefix(s[i:], "$(") {
			_, end, found := findSubst(s, i)
			if !found {
				b.WriteRune(r)
				i += size
				continue
			}
			b.WriteString(s[i:end])
			i = end
			continue
		}
		if shellSep(s, i, kind) {
			n := 1
			if kind == splitStatement && (strings.HasPrefix(s[i:], "&&") || strings.HasPrefix(s[i:], "||")) {
				n = 2
			}
			if kind == splitPipe && strings.HasPrefix(s[i:], "|&") {
				n = 2
			}
			flush()
			i += n
			continue
		}
		b.WriteRune(r)
		i += size
	}
	flush()
	return out
}

func shellSep(s string, i int, kind splitKind) bool {
	switch kind {
	case splitStatement:
		if s[i] == ';' || s[i] == '\n' {
			return true
		}
		if strings.HasPrefix(s[i:], "&&") || strings.HasPrefix(s[i:], "||") {
			return true
		}
		return s[i] == '&' && !(i > 0 && s[i-1] == '|')
	default:
		if strings.HasPrefix(s[i:], "||") {
			return false
		}
		return s[i] == '|'
	}
}
