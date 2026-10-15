package main

import (
	"context"
	"github.com/TITOCHAN2023/fleetForAgent/internal/activity"
	"github.com/TITOCHAN2023/fleetForAgent/internal/hostaudit"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"testing"
	"time"
)

func TestActivityExportBusyReturnsReadableHTTPError(t *testing.T) {
	journal, err := activity.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	snapshot, err := journal.SnapshotForExport(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	a := &Agent{activity: journal}
	response := httptest.NewRecorder()
	a.exportActivity(response, httptest.NewRequest(http.MethodGet, "/api/activity/export", nil))
	if response.Code != http.StatusConflict || response.Header().Get("Content-Disposition") != "" {
		t.Fatal("busy export looked like a download", response.Code, response.Header())
	}
}
func TestHostAuditHealthIsVisibleWhenJournalUnavailable(t *testing.T) {
	a := &Agent{}
	_, session, err := hostaudit.Prepare(exec.Command("unused"), "health", "pane-health", hostaudit.DefaultOptions(false), a.hostAuditSink(context.Background()))
	if err != nil {
		t.Fatal(err)
	}
	a.hostObservations.Add(session)
	session.Close("stop")
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		a.mu.Lock()
		state := a.publicSnapshot()
		a.mu.Unlock()
		if len(state.HostAuditHealth) == 1 && state.HostAuditHealth[0].State == "gap" {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("gap health not visible without persisted journal")
}
