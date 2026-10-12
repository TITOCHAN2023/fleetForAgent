package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const roomViewMaxBody = 128 * 1024

var roomViewID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,96}$`)
var roomViewCapability = regexp.MustCompile(`^[a-f0-9]{64}$`)
var roomViewClient = &http.Client{
	Timeout:       1500 * time.Millisecond,
	Transport:     &http.Transport{Proxy: nil, DisableCompression: true, DisableKeepAlives: true},
	CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
}

type roomViewDescriptor struct {
	Version        int    `json:"version"`
	LeaderID       string `json:"leaderId"`
	InstanceID     string `json:"instanceId"`
	URL            string `json:"url"`
	ReadCapability string `json:"readCapability"`
}
type localRoomSummary struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	LeaderID   string `json:"leaderId"`
	LeaderName string `json:"leaderName"`
	Paused     bool   `json:"paused"`
}
type localLeaderStatus struct {
	ID     string `json:"id"`
	Online bool   `json:"online"`
}
type localRoomMessage struct {
	ID           string `json:"id"`
	RoomID       string `json:"roomId"`
	DiscussionID string `json:"discussionId"`
	AuthorID     string `json:"authorId"`
	AuthorKind   string `json:"authorKind"`
	AuthorName   string `json:"authorName"`
	ToAgentID    string `json:"toAgentId,omitempty"`
	ToAgentName  string `json:"toAgentName,omitempty"`
	Seq          int64  `json:"seq"`
	Text         string `json:"text"`
	CreatedAt    int64  `json:"createdAt"`
}
type localMessagePage struct {
	Messages   []localRoomMessage `json:"messages"`
	ContextRev int64              `json:"contextRev"`
	HasMore    bool               `json:"hasMore"`
	NextCursor *int64             `json:"nextCursor"`
}

func readRoomDescriptor(id string) (roomViewDescriptor, error) {
	var d roomViewDescriptor
	if !roomViewID.MatchString(id) {
		return d, errors.New("invalid leader")
	}
	directory := filepath.Join(fleetHome(), "rooms")
	stat, err := os.Lstat(directory)
	if err != nil {
		return d, err
	}
	if !stat.IsDir() || stat.Mode().Perm()&0077 != 0 {
		return d, errors.New("unsafe directory")
	}
	path := filepath.Join(directory, id+".json")
	before, err := os.Lstat(path)
	if err != nil {
		return d, err
	}
	if !before.Mode().IsRegular() || before.Mode().Perm()&0077 != 0 || before.Size() > 4096 {
		return d, errors.New("unsafe descriptor")
	}
	file, err := os.Open(path)
	if err != nil {
		return d, err
	}
	defer file.Close()
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) {
		return d, errors.New("descriptor changed")
	}
	body, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil || len(body) > 4096 {
		return d, errors.New("invalid descriptor")
	}
	if json.Unmarshal(body, &d) != nil || d.Version != 1 || d.LeaderID != id || !roomViewID.MatchString(d.InstanceID) || !roomViewCapability.MatchString(d.ReadCapability) {
		return d, errors.New("invalid descriptor")
	}
	u, err := url.Parse(d.URL)
	if err != nil || u.Scheme != "http" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return d, errors.New("invalid endpoint")
	}
	ip := net.ParseIP(u.Hostname())
	port, err := strconv.Atoi(u.Port())
	if ip == nil || !ip.IsLoopback() || err != nil || port < 1 || port > 65535 {
		return d, errors.New("endpoint must be literal loopback")
	}
	return d, nil
}

func readLocalRooms(ctx context.Context, d roomViewDescriptor, path string, result any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.URL+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+d.ReadCapability)
	response, err := roomViewClient.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("local leader unavailable")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, roomViewMaxBody+1))
	if err != nil || len(body) > roomViewMaxBody {
		return errors.New("invalid local response")
	}
	return json.Unmarshal(body, result)
}

func roomViewHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/rooms" && r.URL.Path != "/api/room-messages" {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if !settingsLoopbackHost(r.Host) || !settingsSameOrigin(r) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			http.Error(w, "read only", http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Path == "/api/rooms" {
			serveLocalRooms(w, r)
			return
		}
		serveLocalRoomMessages(w, r)
	})
}

func serveLocalRooms(w http.ResponseWriter, r *http.Request) {
	if r.URL.RawQuery != "" {
		http.Error(w, "invalid query", http.StatusBadRequest)
		return
	}
	result := struct {
		MachineName string              `json:"machineName"`
		Rooms       []localRoomSummary  `json:"rooms"`
		Leaders     []localLeaderStatus `json:"leaders"`
	}{MachineName: deviceName(), Rooms: []localRoomSummary{}, Leaders: []localLeaderStatus{}}
	path := filepath.Join(fleetHome(), "rooms")
	stat, err := os.Lstat(path)
	if os.IsNotExist(err) {
		writeJSON(w, result)
		return
	}
	if err != nil || !stat.IsDir() || stat.Mode().Perm()&0077 != 0 {
		http.Error(w, "local discovery unavailable", http.StatusServiceUnavailable)
		return
	}
	directory, err := os.Open(path)
	if err != nil {
		writeJSON(w, result)
		return
	}
	defer directory.Close()
	entries, err := directory.ReadDir(65)
	if err != nil && err != io.EOF || len(entries) > 64 {
		http.Error(w, "local discovery limit exceeded", http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		if !roomViewID.MatchString(id) {
			continue
		}
		status := localLeaderStatus{ID: id}
		d, err := readRoomDescriptor(id)
		var page struct {
			Rooms []localRoomSummary `json:"rooms"`
		}
		if err == nil && readLocalRooms(ctx, d, "/rooms", &page) == nil {
			status.Online = true
			for _, room := range page.Rooms {
				if room.LeaderID == id && roomViewID.MatchString(room.ID) && len(room.Name) <= 512 && len(room.LeaderName) <= 512 && len(result.Rooms) < 512 {
					result.Rooms = append(result.Rooms, room)
				}
			}
		}
		result.Leaders = append(result.Leaders, status)
	}
	writeJSON(w, result)
}

func serveLocalRoomMessages(w http.ResponseWriter, r *http.Request) {
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		http.Error(w, "invalid query", http.StatusBadRequest)
		return
	}
	for key, values := range q {
		if len(values) != 1 || (key != "leaderId" && key != "roomId" && key != "discussionId" && key != "afterSeq" && key != "limit") {
			http.Error(w, "invalid query", http.StatusBadRequest)
			return
		}
	}
	if !roomViewID.MatchString(q.Get("leaderId")) || !roomViewID.MatchString(q.Get("roomId")) {
		http.Error(w, "invalid ID", http.StatusBadRequest)
		return
	}
	if q.Get("discussionId") == "" {
		q.Set("discussionId", "main")
	}
	if !roomViewID.MatchString(q.Get("discussionId")) {
		http.Error(w, "invalid discussion", http.StatusBadRequest)
		return
	}
	for _, key := range []string{"afterSeq", "limit"} {
		if !q.Has(key) {
			continue
		}
		n, err := strconv.ParseUint(q.Get(key), 10, 53)
		if err != nil || key == "limit" && (n < 1 || n > 100) {
			http.Error(w, "invalid cursor", http.StatusBadRequest)
			return
		}
	}
	descriptor, err := readRoomDescriptor(q.Get("leaderId"))
	if err != nil {
		http.Error(w, "local leader unavailable", http.StatusServiceUnavailable)
		return
	}
	q.Del("leaderId")
	var result localMessagePage
	if readLocalRooms(r.Context(), descriptor, "/messages?"+q.Encode(), &result) != nil {
		http.Error(w, "local leader unavailable", http.StatusServiceUnavailable)
		return
	}
	if len(result.Messages) > 100 {
		http.Error(w, "invalid local response", http.StatusServiceUnavailable)
		return
	}
	if result.Messages == nil {
		result.Messages = []localRoomMessage{}
	}
	writeJSON(w, result)
}
