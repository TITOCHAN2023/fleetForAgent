//go:build windows

package main

import (
	"context"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

const windowsPluginTreeHelperEnv = "FLEET_TEST_WINDOWS_PLUGIN_TREE_HELPER"

func TestWindowsPluginProcessTreeHelper(t *testing.T) {
	switch os.Getenv(windowsPluginTreeHelperEnv) {
	case "leader":
		cmd := exec.Command(os.Args[0], "-test.run=^TestWindowsPluginProcessTreeHelper$")
		cmd.Env = append(os.Environ(), windowsPluginTreeHelperEnv+"=descendant")
		if err := cmd.Start(); err != nil {
			os.Exit(2)
		}
		if err := os.WriteFile(os.Getenv("FLEET_TEST_WINDOWS_PLUGIN_TREE_PID_FILE"), []byte(strconv.Itoa(cmd.Process.Pid)), 0o600); err != nil {
			_ = cmd.Process.Kill()
			os.Exit(3)
		}
		_, _ = io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	case "descendant":
		for {
			time.Sleep(time.Hour)
		}
	default:
		t.Skip("helper subprocess only")
	}
}

func TestWindowsManagedTaskLeaderExitKillsDescendant(t *testing.T) {
	pidFile := t.TempDir() + `\descendant.pid`
	cmd := exec.Command(os.Args[0], "-test.run=^TestWindowsPluginProcessTreeHelper$")
	cmd.Env = append(os.Environ(),
		windowsPluginTreeHelperEnv+"=leader",
		"FLEET_TEST_WINDOWS_PLUGIN_TREE_PID_FILE="+pidFile,
	)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runPluginCommand(ctx, cmd) }()

	deadline := time.Now().Add(3 * time.Second)
	var childPID uint64
	for time.Now().Before(deadline) {
		raw, readErr := os.ReadFile(pidFile)
		if readErr == nil {
			childPID, err = strconv.ParseUint(strings.TrimSpace(string(raw)), 10, 32)
			if err == nil && childPID != 0 {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if childPID == 0 {
		_ = stdin.Close()
		cancel()
		<-done
		t.Fatal("managed plugin descendant did not start")
	}
	child, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_TERMINATE, false, uint32(childPID))
	if err != nil {
		_ = stdin.Close()
		cancel()
		<-done
		t.Fatal(err)
	}
	defer func() {
		_ = windows.TerminateProcess(child, 1)
		_ = windows.CloseHandle(child)
	}()

	_ = stdin.Close()
	if err := <-done; err != nil {
		t.Fatalf("managed plugin leader exit: %v", err)
	}
	result, err := windows.WaitForSingleObject(child, 2000)
	if err != nil {
		t.Fatal(err)
	}
	if result != windows.WAIT_OBJECT_0 {
		t.Fatalf("plugin descendant survived leader exit; wait result=%#x", result)
	}
}
