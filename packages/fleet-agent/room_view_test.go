package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func roomViewFixture(t *testing.T, endpoint string) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("FLEET_HOME", home)
	directory := filepath.Join(home, "rooms")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	descriptor := roomViewDescriptor{Version: 1, LeaderID: "leader", InstanceID: "instance", URL: endpoint, ReadCapability: strings.Repeat("a", 64)}
	body, _ := json.Marshal(descriptor)
	path := filepath.Join(directory, "leader.json")
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}
func roomViewRequest(path string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("GET", "http://127.0.0.1:17890"+path, nil)
	for key, value := range headers {
		if key == "Host" {
			req.Host = value
		} else {
			req.Header.Set(key, value)
		}
	}
	response := httptest.NewRecorder()
	roomViewHandler(http.NotFoundHandler()).ServeHTTP(response, req)
	return response
}

func TestRoomViewRejectsCrossSiteAndArbitraryTargets(t *testing.T) {
	roomViewFixture(t, "http://127.0.0.1:1")
	for _, headers := range []map[string]string{{"Host": "attacker.example"}, {"Origin": "http://attacker.example"}, {"Sec-Fetch-Site": "cross-site"}, {"Origin": "http://localhost:17890"}} {
		if roomViewRequest("/api/rooms", headers).Code != 403 {
			t.Fatalf("accepted %v", headers)
		}
	}
	for _, query := range []string{"leaderId=../secret&roomId=x", "leaderId=leader&roomId=x&url=http://example.com", "leaderId=leader&roomId=x&limit=101", "leaderId=leader&roomId=x&afterSeq=-1", "leaderId=leader&roomId=x&roomId=y"} {
		if roomViewRequest("/api/room-messages?"+query, nil).Code != 400 {
			t.Fatalf("accepted %s", query)
		}
	}
	req := httptest.NewRequest("POST", "http://127.0.0.1:17890/api/rooms", nil)
	response := httptest.NewRecorder()
	roomViewHandler(http.NotFoundHandler()).ServeHTTP(response, req)
	if response.Code != 405 {
		t.Fatal("mutation accepted")
	}
}

func TestRoomViewBoundsResponsesAndIgnoresProxy(t *testing.T) {
	hits := 0
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++; http.Error(w, "proxy", 500) }))
	defer proxy.Close()
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("http_proxy", proxy.URL)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(localMessagePage{Messages: []localRoomMessage{{Text: strings.Repeat("x", roomViewMaxBody+1)}}})
	}))
	defer upstream.Close()
	// Exercise the transport directly so a filesystem rejection cannot mask a
	// broken size limit or proxy setting on an unsupported discovery platform.
	d := roomViewDescriptor{URL: upstream.URL, ReadCapability: strings.Repeat("a", 64)}
	var result localMessagePage
	if err := readLocalRooms(context.Background(), d, "/messages", &result); err == nil || err.Error() != "invalid local response" || hits != 0 {
		t.Fatalf("oversized response error %v, proxy hits %d", err, hits)
	}
}

func TestRoomViewDoesNotFollowRedirects(t *testing.T) {
	hits := 0
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Write([]byte(`{"rooms":[]}`))
	}))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusFound)
	}))
	defer redirect.Close()
	d := roomViewDescriptor{URL: redirect.URL, ReadCapability: strings.Repeat("a", 64)}
	var result any
	if err := readLocalRooms(context.Background(), d, "/rooms", &result); err == nil || hits != 0 {
		t.Fatalf("redirect error %v, destination hits %d", err, hits)
	}
}
