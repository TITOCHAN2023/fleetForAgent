package main

import (
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
func TestRoomViewReadsLocalAndDoesNotExposeCapability(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("a", 64) {
			t.Error("missing private read capability")
		}
		switch r.URL.Path {
		case "/rooms":
			w.Write([]byte(`{"rooms":[{"id":"room-a","name":"本地房间","leaderId":"leader"}],"readCapability":"secret"}`))
		case "/messages":
			if r.URL.Query().Get("afterSeq") != "30" || r.URL.Query().Get("discussionId") != "main" {
				t.Error("missing cursor or discussion")
			}
			w.Write([]byte(`{"messages":[{"id":"m","text":"离线消息 <script>","seq":31,"authorId":"member","createdAt":1}],"nextCursor":31,"hasMore":true,"contextRev":42,"secret":"do-not-forward"}`))
		}
	}))
	defer upstream.Close()
	roomViewFixture(t, upstream.URL)
	for _, path := range []string{"/api/rooms", "/api/room-messages?leaderId=leader&roomId=room-a&afterSeq=30&limit=1"} {
		response := roomViewRequest(path, nil)
		if response.Code != 200 {
			t.Fatalf("%s: %d %s", path, response.Code, response.Body.String())
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("cache enabled")
		}
		for _, secret := range []string{strings.Repeat("a", 64), "readCapability", "do-not-forward", upstream.URL} {
			if strings.Contains(response.Body.String(), secret) {
				t.Fatalf("leaked %s", secret)
			}
		}
	}
	upstream.Close()
	response := roomViewRequest("/api/rooms", nil)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"online":false`) {
		t.Fatalf("stale discovery: %s", response.Body.String())
	}
	if roomViewRequest("/api/room-messages?leaderId=leader&roomId=room-a", nil).Code != 503 {
		t.Fatal("offline must be explicit")
	}
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
func TestRoomViewRejectsUnsafeDescriptorsAndRedirects(t *testing.T) {
	hits := 0
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++; w.Write([]byte(`{"rooms":[]}`)) }))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 302) }))
	defer redirect.Close()
	path := roomViewFixture(t, redirect.URL)
	roomViewRequest("/api/rooms", nil)
	if hits != 0 {
		t.Fatal("followed redirect with read capability")
	}
	for _, endpoint := range []string{"http://example.com:80", "http://localhost:80", "http://127.0.0.1:80/path", "http://user@127.0.0.1:80", "https://127.0.0.1:80"} {
		d := roomViewDescriptor{Version: 1, LeaderID: "leader", InstanceID: "instance", URL: endpoint, ReadCapability: strings.Repeat("a", 64)}
		b, _ := json.Marshal(d)
		os.WriteFile(path, b, 0600)
		if _, err := readRoomDescriptor("leader"); err == nil {
			t.Fatalf("accepted %s", endpoint)
		}
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := readRoomDescriptor("leader"); err == nil {
		t.Fatal("accepted public descriptor")
	}
	os.Remove(path)
	if err := os.Symlink("/etc/passwd", path); err != nil {
		t.Fatal(err)
	}
	if _, err := readRoomDescriptor("leader"); err == nil {
		t.Fatal("accepted symlink")
	}
}
func TestRoomViewBoundsResponsesAndIgnoresProxy(t *testing.T) {
	hits := 0
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++; http.Error(w, "proxy", 500) }))
	defer proxy.Close()
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("http_proxy", proxy.URL)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(strings.Repeat("x", roomViewMaxBody+1))) }))
	defer upstream.Close()
	roomViewFixture(t, upstream.URL)
	response := roomViewRequest("/api/room-messages?leaderId=leader&roomId=x", nil)
	if response.Code != 503 || hits != 0 {
		t.Fatalf("status %d proxy %d", response.Code, hits)
	}
}

func TestRoomViewIdentityMetadataIsExplicitAndLocalMachineOwned(t *testing.T) {
	t.Setenv("FLEET_NAME", "开发机 A")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/rooms":
			w.Write([]byte(`{"machineName":"remote impostor","rooms":[{"id":"room-a","name":"本地房间","leaderId":"leader","leaderName":"Grok 主会话","readCapability":"nested-secret","role":"owner"}]}`))
		case "/messages":
			w.Write([]byte(`{"messages":[{"id":"a","authorId":"coder-a","authorKind":"agent","authorName":"Codex","toAgentId":"coder-b","toAgentName":"Codex","text":"first","readCapability":"nested-secret"},{"id":"b","authorId":"coder-b","authorKind":"agent","authorName":"Codex","text":"second","provider":"untrusted-provider"},{"id":"human","authorId":"coder-a","authorKind":"user","authorName":"coder-a","text":"human"}],"hasMore":false,"nextCursor":3,"contextRev":3}`))
		}
	}))
	defer upstream.Close()
	roomViewFixture(t, upstream.URL)
	roomsResponse := roomViewRequest("/api/rooms", nil)
	var rooms struct {
		MachineName string             `json:"machineName"`
		Rooms       []localRoomSummary `json:"rooms"`
	}
	if err := json.Unmarshal(roomsResponse.Body.Bytes(), &rooms); err != nil {
		t.Fatal(err)
	}
	if rooms.MachineName != "开发机 A" || len(rooms.Rooms) != 1 || rooms.Rooms[0].LeaderID != "leader" || rooms.Rooms[0].LeaderName != "Grok 主会话" {
		t.Fatalf("wrong local identity: %+v", rooms)
	}
	messagesResponse := roomViewRequest("/api/room-messages?leaderId=leader&roomId=room-a", nil)
	var page localMessagePage
	if err := json.Unmarshal(messagesResponse.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Messages) != 3 {
		t.Fatalf("messages %+v", page)
	}
	if page.Messages[0].AuthorName != "Codex" || page.Messages[1].AuthorName != "Codex" || page.Messages[0].AuthorID == page.Messages[1].AuthorID {
		t.Fatal("same-name agents lost stable identities")
	}
	if page.Messages[0].ToAgentID != "coder-b" || page.Messages[0].ToAgentName != "Codex" || page.Messages[2].AuthorName != "coder-a" || page.Messages[2].AuthorKind != "user" {
		t.Fatal("recipient or human metadata changed")
	}
	for _, response := range []*httptest.ResponseRecorder{roomsResponse, messagesResponse} {
		if response.Code != 200 {
			t.Fatalf("status %d", response.Code)
		}
		for _, secret := range []string{"remote impostor", "nested-secret", "readCapability", "untrusted-provider", `"role"`, strings.Repeat("a", 64)} {
			if strings.Contains(response.Body.String(), secret) {
				t.Fatalf("forwarded unselected metadata: %s", secret)
			}
		}
	}
}
