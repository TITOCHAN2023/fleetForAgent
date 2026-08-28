package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestSecureSettingsHandlerBlocksBrowserApprovalBypass(t *testing.T) {
	tests := []struct {
		name        string
		method      string
		path        string
		host        string
		contentType string
		origin      string
		fetchSite   string
		wantStatus  int
		wantCalled  bool
	}{
		{name: "native CLI", method: http.MethodPost, path: "/api/approve", contentType: "application/json", wantStatus: http.StatusNoContent, wantCalled: true},
		{name: "same origin browser", method: http.MethodPost, path: "/api/approve", contentType: "application/json; charset=utf-8", origin: "http://127.0.0.1:17890", fetchSite: "same-origin", wantStatus: http.StatusNoContent, wantCalled: true},
		{name: "GET image request", method: http.MethodGet, path: "/api/approve", wantStatus: http.StatusMethodNotAllowed},
		{name: "simple form POST", method: http.MethodPost, path: "/api/approve", contentType: "text/plain", wantStatus: http.StatusUnsupportedMediaType},
		{name: "foreign origin", method: http.MethodPost, path: "/api/approve", contentType: "application/json", origin: "https://evil.example", fetchSite: "cross-site", wantStatus: http.StatusForbidden},
		{name: "opaque origin", method: http.MethodPost, path: "/api/approve", contentType: "application/json", origin: "null", wantStatus: http.StatusForbidden},
		{name: "other loopback origin", method: http.MethodPost, path: "/api/approve", contentType: "application/json", origin: "http://127.0.0.1:9000", fetchSite: "same-site", wantStatus: http.StatusForbidden},
		{name: "DNS rebinding host", method: http.MethodPost, path: "/api/approve", host: "evil.example", contentType: "application/json", wantStatus: http.StatusForbidden},
		{name: "state read", method: http.MethodGet, path: "/api/state", wantStatus: http.StatusNoContent, wantCalled: true},
		{name: "state mutation", method: http.MethodPost, path: "/api/state", contentType: "application/json", wantStatus: http.StatusMethodNotAllowed},
		{name: "unknown API", method: http.MethodGet, path: "/api/missing", wantStatus: http.StatusNotFound},
		{name: "update read", method: http.MethodGet, path: "/api/update", wantStatus: http.StatusNoContent, wantCalled: true},
		{name: "update mutation", method: http.MethodPost, path: "/api/update", contentType: "application/json", wantStatus: http.StatusNoContent, wantCalled: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var called atomic.Bool
			handler := secureSettingsHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called.Store(true)
				w.WriteHeader(http.StatusNoContent)
			}))
			req := httptest.NewRequest(tt.method, "http://127.0.0.1:17890"+tt.path, strings.NewReader("{}"))
			if tt.host != "" {
				req.Host = tt.host
			}
			if tt.contentType != "" {
				req.Header.Set("Content-Type", tt.contentType)
			}
			if tt.origin != "" {
				req.Header.Set("Origin", tt.origin)
			}
			if tt.fetchSite != "" {
				req.Header.Set("Sec-Fetch-Site", tt.fetchSite)
			}
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, req)
			if res.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", res.Code, tt.wantStatus)
			}
			if called.Load() != tt.wantCalled {
				t.Fatalf("downstream called = %v, want %v", called.Load(), tt.wantCalled)
			}
		})
	}
}

func TestSettingsLoopbackHost(t *testing.T) {
	for _, host := range []string{"127.0.0.1:17890", "[::1]:17890", "localhost:17890", "LOCALHOST.:17890"} {
		if !settingsLoopbackHost(host) {
			t.Errorf("loopback host rejected: %q", host)
		}
	}
	for _, host := range []string{"", "0.0.0.0:17890", "127.0.0.1.evil:17890", "example.com"} {
		if settingsLoopbackHost(host) {
			t.Errorf("non-loopback host accepted: %q", host)
		}
	}
}
