package main

import (
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
)

var settingsMutationPaths = map[string]struct{}{
	"/api/enabled":    {},
	"/api/permit":     {},
	"/api/connect":    {},
	"/api/approve":    {},
	"/api/deny":       {},
	"/api/quit":       {},
	"/api/restart":    {},
	"/api/autoupdate": {},
	"/api/rollback":   {},
}

// secureSettingsHandler is the trust boundary around the loopback settings UI.
// Binding to loopback is not a CSRF defense: browsers can still submit requests
// to 127.0.0.1, and DNS rebinding can supply a hostile Host header.
func secureSettingsHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !settingsLoopbackHost(r.Host) || !settingsSameOrigin(r) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		switch {
		case r.URL.Path == "/api/state":
			if r.Method != http.MethodGet {
				w.Header().Set("Allow", http.MethodGet)
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
		case r.URL.Path == "/api/update" && r.Method == http.MethodGet:
			// Read-only update status and refresh share this route with POST.
		case r.URL.Path == "/api/update":
			if !settingsJSONMutation(w, r) {
				return
			}
		case isSettingsMutation(r.URL.Path):
			if !settingsJSONMutation(w, r) {
				return
			}
		case strings.HasPrefix(r.URL.Path, "/api/"):
			http.NotFound(w, r)
			return
		case r.Method != http.MethodGet && r.Method != http.MethodHead:
			w.Header().Set("Allow", http.MethodGet+", "+http.MethodHead)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func isSettingsMutation(path string) bool {
	_, ok := settingsMutationPaths[path]
	return ok
}

func settingsJSONMutation(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || !strings.EqualFold(mediaType, "application/json") {
		http.Error(w, "content type must be application/json", http.StatusUnsupportedMediaType)
		return false
	}
	return true
}

func settingsLoopbackHost(hostport string) bool {
	host := hostport
	if parsed, _, err := net.SplitHostPort(hostport); err == nil {
		host = parsed
	} else if strings.HasPrefix(hostport, "[") && strings.HasSuffix(hostport, "]") {
		host = strings.TrimSuffix(strings.TrimPrefix(hostport, "["), "]")
	}
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func settingsSameOrigin(r *http.Request) bool {
	switch strings.ToLower(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site"))) {
	case "", "none", "same-origin":
	default:
		return false
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true // Native CLI requests do not carry browser origin metadata.
	}
	u, err := url.Parse(origin)
	return err == nil && u.Scheme == "http" && u.User == nil && u.Path == "" && u.RawQuery == "" &&
		u.Fragment == "" && strings.EqualFold(u.Host, r.Host) && settingsLoopbackHost(u.Host)
}
