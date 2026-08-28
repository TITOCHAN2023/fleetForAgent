//go:build !windows

package main

import (
	"bufio"
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestPluginPeerAbortKillsDescendantProcessGroup(t *testing.T) {
	pidFile := t.TempDir() + "/child.pid"
	cmd := exec.Command("/bin/sh", "-c", `sleep 60 & echo $! > "$1"; wait`, "fleet-peer-test", pidFile)
	configurePluginProcess(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	peer := &processPluginPeer{
		cmd: cmd, ctx: context.Background(), stdin: stdin,
		stdout: bufio.NewReader(stdout), stderr: &capBuffer{max: 1024}, done: make(chan struct{}),
	}
	cmd.Stderr = peer.stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	var childPID int
	for time.Now().Before(deadline) {
		raw, readErr := os.ReadFile(pidFile)
		if readErr == nil {
			childPID, err = strconv.Atoi(strings.TrimSpace(string(raw)))
			if err == nil && childPID > 0 {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if childPID <= 0 {
		peer.Abort()
		t.Fatal("plugin descendant did not start")
	}
	peer.Abort()
	for time.Now().Before(deadline) {
		err = syscall.Kill(childPID, 0)
		if errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("plugin descendant %d survived process-group abort: %v", childPID, err)
}

func TestPluginPeerCancelCannotBeBlockedByFullStdin(t *testing.T) {
	cmd := exec.Command("/bin/sh", "-c", `trap '' TERM; sleep 60`)
	configurePluginProcess(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	peer := &processPluginPeer{
		cmd: cmd, ctx: context.Background(), stdin: stdin,
		stdout: bufio.NewReader(stdout), stderr: &capBuffer{max: 1024}, done: make(chan struct{}),
	}
	cmd.Stderr = peer.stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	writerStarted := make(chan struct{})
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		close(writerStarted)
		for {
			if err := peer.WriteData(make([]byte, 32<<10)); err != nil {
				return
			}
		}
	}()
	<-writerStarted
	time.Sleep(100 * time.Millisecond)
	cancelDone := make(chan struct{})
	go func() {
		peer.Cancel()
		close(cancelDone)
	}()
	select {
	case <-cancelDone:
	case <-time.After(3 * time.Second):
		_ = stdin.Close()
		terminatePluginProcessTree(cmd, true)
		_ = cmd.Wait()
		t.Fatal("cancel was blocked behind a plugin stdin write")
	}
	select {
	case <-writerDone:
	case <-time.After(time.Second):
		t.Fatal("stdin writer stayed blocked after process-tree cancellation")
	}
	if err := syscall.Kill(cmd.Process.Pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("plugin process %d survived cancellation: %v", cmd.Process.Pid, err)
	}
}

func TestTaskPluginTimeoutKillsDescendantProcessGroup(t *testing.T) {
	pidFile := t.TempDir() + "/child.pid"
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	cmd := exec.Command("/bin/sh", "-c", `sleep 60 & echo $! > "$1"; wait`, "fleet-task-test", pidFile)
	err := runPluginCommand(ctx, cmd)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("runPluginCommand error = %v, want deadline exceeded", err)
	}
	raw, readErr := os.ReadFile(pidFile)
	if readErr != nil {
		t.Fatalf("read descendant pid: %v", readErr)
	}
	childPID, parseErr := strconv.Atoi(strings.TrimSpace(string(raw)))
	if parseErr != nil || childPID <= 0 {
		t.Fatalf("invalid descendant pid %q: %v", raw, parseErr)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		err = syscall.Kill(childPID, 0)
		if errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("task plugin descendant %d survived timeout: %v", childPID, err)
}
