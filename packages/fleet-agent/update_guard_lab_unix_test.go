//go:build !windows

package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket/wsjson"
)

func guardLabSend(t *testing.T, lab *autoUpdateLab, env Envelope) {
	t.Helper()
	lab.hub.mu.Lock()
	c := lab.hub.conns[lab.deviceID]
	lab.hub.mu.Unlock()
	if c == nil {
		t.Fatal("lab device offline")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, c, env); err != nil {
		t.Fatal(err)
	}
}

func guardLabReply(t *testing.T, lab *autoUpdateLab, corr, kind string) Envelope {
	t.Helper()
	timer := time.NewTimer(12 * time.Second)
	defer timer.Stop()
	for {
		select {
		case env := <-lab.hub.replies:
			if env.Corr == corr && env.Type == kind {
				return env
			}
		case <-timer.C:
			t.Fatalf("missing %s for %s", kind, corr)
			return Envelope{}
		}
	}
}

// Real binaries and process handoff, confined to disposable VM/container labs.
// Version labels distinguish two builds of this source, not historical releases.
func TestAutoUpdateRealProcessGuard(t *testing.T) {
	if os.Getenv("FLEET_OPERATION_LAB") != "1" {
		t.Skip("disposable VM/container only")
	}
	oldBin := buildAgentVersion(t, "0.3.0")
	newBin := buildAgentVersion(t, "0.3.2")
	asset := releaseAssetNames(runtime.GOOS, runtime.GOARCH)[0]
	archive, sum := packAgentAs(t, newBin, asset)
	for _, kind := range []string{"run", "plugin"} {
		t.Run(kind, func(t *testing.T) {
			download, resume := make(chan struct{}), make(chan struct{})
			var first, unblock sync.Once
			lab := newAutoUpdateLab(t, oldBin, archive, asset, sum, func() {
				first.Do(func() { close(download); <-resume })
			})
			t.Cleanup(func() { unblock.Do(func() { close(resume) }) })
			pid := lab.startAgent(true, "allow")
			lab.waitOnline("0.3.0")
			counter := filepath.Join(lab.home, "counter")
			command := "echo once >> " + strconv.Quote(counter) + "; sleep 4; printf task-done"
			env := Envelope{V: 1, Type: "run", Corr: "guard-job", Body: map[string]any{
				"command": command, "fingerprint": "guard-owner", "request_id": "guard-job",
			}}
			accepted, result := "accepted", "result"
			if kind == "plugin" {
				installGuardLabPlugin(t, lab.home, counter)
				env.Type = "plugin"
				env.Body = map[string]any{"operation": "invoke", "plugin_id": "fleet.transfer", "action": "prepare_source"}
				accepted, result = "plugin_accepted", "plugin_result"
			}
			lab.hub.setAdvert("0.3.2", lab.baseURL)
			select {
			case <-download:
			case <-time.After(12 * time.Second):
				t.Fatal("download did not start")
			}
			guardLabSend(t, lab, env)
			guardLabReply(t, lab, env.Corr, accepted)
			unblock.Do(func() { close(resume) })
			time.Sleep(time.Second)
			if getState(t, lab.addr).AgentVer != "0.3.0" || listenPIDOrZero(lab.addr) != pid {
				t.Fatal("update interrupted work arriving during download")
			}
			got := guardLabReply(t, lab, env.Corr, result)
			if got.Body["ok"] != true {
				t.Fatalf("work did not complete: %+v", got)
			}
			newPID := waitReplacedDaemon(t, lab.addr, pid)
			lab.waitOnline("0.3.2")
			if getState(t, lab.addr).DeviceID != lab.deviceID {
				t.Fatal("upgrade changed device identity")
			}
			if kind == "run" {
				// Same request after restart must return its receipt, not rerun.
				guardLabSend(t, lab, env)
				replay := guardLabReply(t, lab, env.Corr, result)
				if replay.Body["ok"] != true || replay.Body["exit_code"] != float64(0) || replay.Body["output_unavailable"] != true {
					t.Fatalf("durable receipt lost after upgrade: %+v", replay)
				}
			}
			if got := string(mustRead(t, counter)); got != "once\n" {
				t.Fatalf("task executed more than once: %q", got)
			}
			t.Logf("%s completed once; pid %d -> %d only afterward", kind, pid, newPID)
		})
	}
}

func installGuardLabPlugin(t *testing.T, home, counter string) {
	t.Helper()
	dir := filepath.Join(home, "plugins", "fleet.transfer")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	// A local protocol fixture, not an official artifact or installation test.
	body := fmt.Sprintf("#!/bin/sh\nprintf 'once\\n' >> %s\nsleep 4\nprintf '%%s' '{\"ok\":true,\"result\":\"plugin-done\"}'\n", strconv.Quote(counter))
	entry := "fleet-transfer-plugin"
	if err := os.WriteFile(filepath.Join(dir, entry), []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	meta := installedPlugin{ID: "fleet.transfer", Name: "Lab fixture", Version: "0.1.0", Publisher: "Fleet Official", License: "MIT",
		Repository: "https://github.com/TITOCHAN2023/fleet-transfer-plugin", ArtifactURL: "https://github.com/TITOCHAN2023/fleet-transfer-plugin/releases/download/v0.1.0/" + entry,
		SHA256: sha256Hex(body), Entrypoint: entry, Actions: []string{"prepare_source"}, InstalledAt: time.Now().UnixMilli()}
	if err := writePluginMeta(dir, meta); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(counter, home+string(os.PathSeparator)) {
		t.Fatal("fixture counter escaped lab")
	}
}
