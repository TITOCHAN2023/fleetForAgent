//go:build !windows

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// The Room runner requires POSIX. These integration tests rely on its private
// 0700 directory and 0600 descriptor contract, which Windows chmod cannot create.
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

func TestRoomViewRejectsUnsafeDescriptors(t *testing.T) {
	path := roomViewFixture(t, "http://127.0.0.1:1")
	for _, endpoint := range []string{"http://example.com:80", "http://localhost:80", "http://127.0.0.1:80/path", "http://user@127.0.0.1:80", "https://127.0.0.1:80"} {
		d := roomViewDescriptor{Version: 1, LeaderID: "leader", InstanceID: "instance", URL: endpoint, ReadCapability: strings.Repeat("a", 64)}
		b, _ := json.Marshal(d)
		if err := os.WriteFile(path, b, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := readRoomDescriptor("leader"); err == nil {
			t.Fatalf("accepted %s", endpoint)
		}
	}
	// Restore a valid descriptor: otherwise a bad URL could hide a missing
	// permission check and make this assertion pass for the wrong reason.
	valid := roomViewDescriptor{Version: 1, LeaderID: "leader", InstanceID: "instance", URL: "http://127.0.0.1:1", ReadCapability: strings.Repeat("a", 64)}
	body, _ := json.Marshal(valid)
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readRoomDescriptor("leader"); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := readRoomDescriptor("leader"); err == nil {
		t.Fatal("accepted public descriptor")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/passwd", path); err != nil {
		t.Fatal(err)
	}
	if _, err := readRoomDescriptor("leader"); err == nil {
		t.Fatal("accepted symlink")
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
