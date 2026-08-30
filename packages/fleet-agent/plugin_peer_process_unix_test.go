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
	tree, err := startPluginProcess(cmd)
	if err != nil {
		t.Fatal(err)
	}
	peer.tree = tree
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
	tree, err := startPluginProcess(cmd)
	if err != nil {
		t.Fatal(err)
	}
	peer.tree = tree
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
	cancelDone := make(chan bool, 1)
	go func() {
		cancelDone <- peer.Cancel()
	}()
	select {
	case applied := <-cancelDone:
		if applied {
			t.Fatal("force-killed plugin reported an applied FLPP cancel")
		}
	case <-time.After(3 * time.Second):
		_ = stdin.Close()
		tree.terminate(true)
		_ = peer.waitForExit(time.Second)
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

func TestPluginPeerCleanCancelSweepsDescendantProcessGroup(t *testing.T) {
	pidFile := t.TempDir() + "/child.pid"
	cmd := exec.Command("/bin/sh", "-c", `
		sleep 60 </dev/null >/dev/null 2>&1 &
		echo $! > "$1"
		dd bs=1 count=35 of=/dev/null 2>/dev/null
		printf '\106\114\120\120\001\001\000\000\000\000\000\053{"v":1,"type":"status","status":"canceled"}'
	`, "fleet-peer-clean-cancel", pidFile)
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
	tree, err := startPluginProcess(cmd)
	if err != nil {
		t.Fatal(err)
	}
	peer.tree = tree
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
	readDone := make(chan error, 1)
	go func() {
		_, readErr := peer.ReadRecord()
		readDone <- readErr
	}()
	if !peer.Cancel() {
		t.Fatal("valid canceled status plus clean leader exit did not produce a receipt")
	}
	select {
	case readErr := <-readDone:
		if readErr != nil {
			t.Fatalf("read canceled status: %v", readErr)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled status reader did not finish")
	}
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		err = syscall.Kill(childPID, 0)
		if errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("plugin descendant %d survived clean-cancel process-group sweep: %v", childPID, err)
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

func TestTaskPluginCleanExitKillsDescendantProcessGroup(t *testing.T) {
	pidFile := t.TempDir() + "/child.pid"
	cmd := exec.Command("/bin/sh", "-c", `
		sleep 60 </dev/null >/dev/null 2>&1 &
		echo $! > "$1"
	`, "fleet-task-clean-exit", pidFile)
	if err := runPluginCommand(context.Background(), cmd); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	childPID, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || childPID <= 0 {
		t.Fatalf("invalid descendant pid %q: %v", raw, err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		err = syscall.Kill(childPID, 0)
		if errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("task plugin descendant %d survived clean leader exit: %v", childPID, err)
}
