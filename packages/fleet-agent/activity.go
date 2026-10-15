package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/TITOCHAN2023/fleetForAgent/internal/activity"
	"github.com/TITOCHAN2023/fleetForAgent/internal/hostaudit"
	"github.com/TITOCHAN2023/fleetForAgent/internal/pane"
)

type pluginInvocationKey struct{}
type pluginPrincipalKey struct{}
type pluginInvocation struct {
	V        int    `json:"v"`
	Corr     string `json:"corr"`
	Origin   string `json:"origin"`
	DeviceID string `json:"device_id"`
	Actor    string `json:"actor,omitempty"`
	agent    *Agent
}
type pluginEventScope struct {
	PluginID, Corr, Actor string
	Expires               time.Time
}

func randomLocalToken() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return ""
	}
	return hex.EncodeToString(b[:])
}

func (a *Agent) record(e activity.Event) error { return a.recordAt(a.journal(), e) }
func (a *Agent) recordAt(journal *activity.Store, e activity.Event) error {
	if journal == nil {
		return fmt.Errorf("activity unavailable")
	}
	e.DeviceID = a.deviceID // Immutable after startup configuration is loaded.
	e.Details = activity.SafeDetails(e.Details)
	if err := journal.Append(e); err != nil {
		a.activityMu.Lock()
		a.activityError = err.Error()
		a.activityMu.Unlock()
		return err
	}
	return nil
}

func (a *Agent) activityRequest(env Envelope) {
	a.activityRequestAs(context.Background(), env)
}
func (a *Agent) activityRequestAs(ctx context.Context, env Envelope) {
	actor := a.activityActor(ctx)
	summary := env.Type
	details := map[string]any{}
	for _, key := range []string{"action", "operation", "plugin_id", "pane_id", "x", "y", "x2", "y2", "scroll_x", "scroll_y"} {
		if v, ok := env.Body[key]; ok {
			details[key] = v
		}
	}
	if env.Type == "run" {
		summary, _ = env.Body["command"].(string)
	}
	for _, key := range []string{"text", "keys"} {
		if v, ok := env.Body[key].(string); ok {
			details[key+"_bytes"] = len(v)
		}
	}
	pluginID, _ := env.Body["plugin_id"].(string)
	a.record(activity.Event{Actor: actor, Corr: env.Corr, PluginID: pluginID, Kind: activityKind(env.Type), Phase: "requested", Source: "core", Summary: summary, Details: details})
}

func activityKind(t string) string {
	switch t {
	case "plugin", "plugin_result", "plugin_accepted":
		return "plugin"
	case "desktop_action", "desktop_screenshot", "desktop", "typed", "type":
		return "desktop"
	case "run", "result", "accepted":
		return "command"
	}
	return "control"
}

func (a *Agent) activitySink(sink EnvelopeSink) EnvelopeSink {
	return func(ctx context.Context, e Envelope) error {
		if e.Type != "screen" && e.Type != "panes" {
			phase := "completed"
			if e.Type == "accepted" || e.Type == "plugin_accepted" {
				phase = "running"
			}
			if status, ok := e.Body["status"].(string); ok && status == "waiting_approval" {
				phase = "waiting_approval"
			}
			if ok, exists := e.Body["ok"].(bool); exists && !ok {
				phase = "failed"
			}
			details := map[string]any{}
			for _, key := range []string{"ok", "exit_code", "code", "status", "error"} {
				if v, ok := e.Body[key]; ok {
					details[key] = v
				}
			}
			a.record(activity.Event{Corr: e.Corr, Actor: actorFromContext(ctx), PluginID: stringBody(e.Body, "plugin_id"), Kind: activityKind(e.Type), Phase: phase, Source: "core", Summary: e.Type, Details: details})
		}
		return sink(ctx, e)
	}
}

func (a *Agent) registerPluginScope(id, corr, actor string) (string, func()) {
	token := randomLocalToken()
	if token == "" {
		return "", func() {}
	}
	a.activityMu.Lock()
	if a.pluginScopes == nil {
		a.pluginScopes = map[string]pluginEventScope{}
	}
	a.pluginScopes[token] = pluginEventScope{id, corr, actor, time.Now().Add(time.Hour)}
	a.activityMu.Unlock()
	return token, func() { a.activityMu.Lock(); delete(a.pluginScopes, token); a.activityMu.Unlock() }
}

func (a *Agent) serveActivity(w http.ResponseWriter, r *http.Request) {
	journal := a.journal()
	if journal == nil {
		http.Error(w, "activity unavailable", 503)
		return
	}
	after, _ := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	before, _ := strconv.ParseUint(r.URL.Query().Get("before"), 10, 64)
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	until, _ := strconv.ParseInt(r.URL.Query().Get("until"), 10, 64)
	p, err := journal.Read(activity.Query{After: after, Before: before, Since: since, Until: until, Limit: limit, Kind: r.URL.Query().Get("kind"), PluginID: r.URL.Query().Get("plugin_id"), Corr: r.URL.Query().Get("corr"), Recent: after == 0})
	if err != nil {
		http.Error(w, "activity read failed", 500)
		return
	}
	writeJSON(w, p)
}

func (a *Agent) servePluginActivity(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	a.activityMu.Lock()
	scope, ok := a.pluginScopes[token]
	a.activityMu.Unlock()
	if !ok || time.Now().After(scope.Expires) {
		http.Error(w, "invalid invocation", 403)
		return
	}
	var e activity.Event
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&e) != nil {
		http.Error(w, "invalid event", 400)
		return
	}
	switch e.Kind {
	case "process", "file", "network", "workspace", "coverage":
	default:
		http.Error(w, "invalid event kind", 400)
		return
	}
	e.Corr = scope.Corr
	e.PluginID = scope.PluginID
	e.Source = "plugin"
	e.Actor = scope.Actor
	e.Seq = 0
	e.Time = 0
	if err := a.record(e); err != nil {
		http.Error(w, "activity journal write failed", 503)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func (a *Agent) cancelPluginTasks() {
	a.taskMu.Lock()
	for _, cancel := range a.pluginTasks {
		cancel()
	}
	a.taskMu.Unlock()
}

func (a *Agent) beginPluginTask(ctx context.Context, corr string) (context.Context, func(), error) {
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	if a.pluginTasks == nil {
		a.pluginTasks = map[string]context.CancelFunc{}
	}
	if a.taskCancelled[corr] {
		delete(a.taskCancelled, corr)
		return ctx, func() {}, fmt.Errorf("plugin invocation canceled before start")
	}
	if _, ok := a.pluginTasks[corr]; ok {
		return ctx, func() {}, fmt.Errorf("plugin invocation already running")
	}
	ctx, cancel := context.WithCancel(ctx)
	a.pluginTasks[corr] = cancel
	return ctx, func() { cancel(); a.taskMu.Lock(); delete(a.pluginTasks, corr); a.taskMu.Unlock() }, nil
}

func (a *Agent) recordPluginStarted(ctx context.Context, id, corr, action string) {
	a.record(activity.Event{Actor: actorFromContext(ctx), PluginID: id, Corr: corr, Kind: "plugin", Phase: "started", Source: "core", Summary: action})
}
func (a *Agent) recordPluginInstall(id string) {
	a.record(activity.Event{PluginID: id, Kind: "plugin", Phase: "installed", Source: "local", Summary: "Local package installed"})
}

func (a *Agent) recordCommandProcess(ctx context.Context, corr, command string, pid int, phase string, details map[string]any) {
	if details == nil {
		details = map[string]any{}
	}
	details["pid"], details["observation"] = pid, "native_process"
	a.record(activity.Event{Actor: actorFromContext(ctx), Corr: corr, Kind: "process", Phase: phase, Source: "core", Summary: "Command process", Details: details})
}
func (a *Agent) recordCommandCoverage(ctx context.Context, corr string, pid int) {
	a.record(activity.Event{Actor: actorFromContext(ctx), Corr: corr, Kind: "coverage", Phase: "reported", Source: "core", Summary: "Command process coverage", Details: map[string]any{"root_process_audit": pid > 0, "child_exec_audit": false, "file_access_audit": false, "network_attempt_audit": false}})
}

func (a *Agent) exportActivity(w http.ResponseWriter, r *http.Request) {
	journal := a.journal()
	if journal == nil {
		http.Error(w, "activity unavailable", 503)
		return
	}
	snapshot, err := journal.SnapshotForExport(r.Context())
	if err != nil {
		code := http.StatusServiceUnavailable
		if errors.Is(err, activity.ErrExportBusy) {
			code = http.StatusConflict
		}
		http.Error(w, err.Error(), code)
		return
	}
	defer snapshot.Close()
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Content-Disposition", `attachment; filename="fleet-activity.jsonl"`)
	if err := snapshot.Export(r.Context(), w); err != nil {
		a.activityMu.Lock()
		a.activityError = err.Error()
		a.activityMu.Unlock()
	}
}

func activityPluginID(body map[string]any) string { id, _ := body["plugin_id"].(string); return id }

func actorFromContext(ctx context.Context) string {
	if inv, ok := ctx.Value(pluginInvocationKey{}).(pluginInvocation); ok {
		return inv.Actor
	}
	actor, _ := ctx.Value(pluginPrincipalKey{}).(string)
	if local, _ := ctx.Value(localPluginCallKey{}).(bool); local {
		return "local"
	}
	return actor
}
func stringBody(body map[string]any, key string) string {
	s, _ := body[key].(string)
	return s
}

func (a *Agent) activityActor(ctx context.Context) string {
	if actor := actorFromContext(ctx); actor != "" {
		return actor
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.authKid
}

func (a *Agent) hostAuditSink(ctx context.Context) hostaudit.Sink {
	actor := actorFromContext(ctx)
	journal := a.journal()
	return func(e hostaudit.Event) error {
		err := a.recordAt(journal, activity.Event{Actor: actor, Corr: e.Corr, Kind: e.Kind, Phase: e.Phase, Source: "host_audit", Summary: e.Operation, Details: e.Metadata()})
		if err != nil {
			a.activityMu.Lock()
			a.activityError = "Host observation gap: activity journal unavailable"
			a.activityMu.Unlock()
		}
		return err
	}
}
func (a *Agent) recordHostInput(ctx context.Context, corr string, p *pane.Pane, delivered bool) {
	identity := hostaudit.ProcessIdentity{PID: p.ProcessPID()}
	if session := p.AuditSession(); session != nil {
		identity = session.RootIdentity()
	}
	a.hostAuditSink(ctx)(hostaudit.Event{Kind: "input_delivery", Phase: "observed", Corr: corr, PaneID: p.ID(), ParentCommandCorr: p.Corr(), Process: identity, Evidence: "pane_write", Details: map[string]any{"delivered": delivered, "subsequent_effect_causality": false}})
}
