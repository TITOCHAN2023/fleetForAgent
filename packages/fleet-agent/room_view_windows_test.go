//go:build windows

package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Windows mode bits do not establish the POSIX private-file guarantee required
// by the Room runner. Do not relax discovery checks just to enable the viewer.
func TestRoomViewWindowsRejectsUnverifiedDiscovery(t *testing.T) {
	t.Setenv("FLEET_HOME", t.TempDir())
	response := roomViewRequest("/api/rooms", nil)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"rooms":[]`) {
		t.Fatalf("machine without a Room runner: %d %s", response.Code, response.Body.String())
	}
	hits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Write([]byte(`{"rooms":[]}`))
	}))
	defer upstream.Close()
	roomViewFixture(t, upstream.URL)
	if _, err := readRoomDescriptor("leader"); err == nil {
		t.Fatal("accepted descriptor without verified private permissions")
	}
	for _, path := range []string{"/api/rooms", "/api/room-messages?leaderId=leader&roomId=room-a"} {
		response := roomViewRequest(path, nil)
		if response.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s: %d %s", path, response.Code, response.Body.String())
		}
		if strings.Contains(response.Body.String(), strings.Repeat("a", 64)) {
			t.Fatal("exposed private read capability")
		}
	}
	if hits != 0 {
		t.Fatalf("contacted unverified local endpoint %d times", hits)
	}
}
