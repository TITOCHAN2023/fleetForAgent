package main

import "regexp"

// Remote commands often carry credentials inline (curl -H "Authorization:
// Bearer …", API_KEY=… scripts). daemon.log keeps every command forever, so
// mask the secret part before it reaches the log or /api/state.
var logSecretPatterns = []struct {
	re   *regexp.Regexp
	repl string
}{
	{regexp.MustCompile(`(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}`), "$1 [redacted]"},
	{regexp.MustCompile(`\bflt_[A-Za-z0-9._~+/=-]{8,}`), "flt_[redacted]"},
	{regexp.MustCompile(`\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}`), "$1-[redacted]"},
	{regexp.MustCompile(`\b(ghp|gho|ghu|ghs|github_pat|xox[abprs])_[A-Za-z0-9_]{16,}`), "$1_[redacted]"},
	{regexp.MustCompile(`\bAKIA[A-Z0-9]{16}\b`), "AKIA[redacted]"},
	{regexp.MustCompile(`(?i)([A-Za-z0-9_-]*(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key)[A-Za-z0-9_-]*["']?\s*[=:]\s*["']?)[^\s"'&;|]{4,}`), "$1[redacted]"},
}

func redactSecrets(s string) string {
	for _, p := range logSecretPatterns {
		s = p.re.ReplaceAllString(s, p.repl)
	}
	return s
}
