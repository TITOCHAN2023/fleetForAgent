//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const pluginProcessThreadLookupMax = 250 * time.Millisecond

var errPluginProcessThreadNotFound = errors.New("plugin process thread not found")

type windowsPluginProcessTree struct {
	job  windows.Handle
	once sync.Once
}

func startPluginProcess(cmd *exec.Cmd) (pluginProcessTree, error) {
	tree, err := newWindowsPluginProcessTree()
	if err != nil {
		return nil, err
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= syscall.CREATE_NEW_PROCESS_GROUP | windows.CREATE_SUSPENDED
	if err := cmd.Start(); err != nil {
		tree.close()
		return nil, err
	}
	if err := assignPluginProcessToJob(tree.job, uint32(cmd.Process.Pid)); err != nil {
		return nil, failStartedPluginProcess(cmd, tree, fmt.Errorf("assign plugin process to job: %w", err))
	}
	if err := resumePluginProcess(uint32(cmd.Process.Pid)); err != nil {
		return nil, failStartedPluginProcess(cmd, tree, fmt.Errorf("resume managed plugin process: %w", err))
	}
	return tree, nil
}

func newWindowsPluginProcessTree() (*windowsPluginProcessTree, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("create plugin process job: %w", err)
	}
	tree := &windowsPluginProcessTree{job: job}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		tree.close()
		return nil, fmt.Errorf("configure plugin process job: %w", err)
	}
	return tree, nil
}

func assignPluginProcessToJob(job windows.Handle, pid uint32) error {
	process, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
		false,
		pid,
	)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(process)
	return windows.AssignProcessToJobObject(job, process)
}

func resumePluginProcess(pid uint32) error {
	deadline := time.Now().Add(pluginProcessThreadLookupMax)
	var lastErr error
	for {
		thread, err := openPluginProcessThread(pid)
		if err == nil {
			previous, resumeErr := windows.ResumeThread(thread)
			windows.CloseHandle(thread)
			if resumeErr != nil {
				return resumeErr
			}
			if previous != 1 {
				return fmt.Errorf("unexpected primary thread suspend count %d", previous)
			}
			return nil
		}
		lastErr = err
		if time.Now().After(deadline) {
			return lastErr
		}
		time.Sleep(time.Millisecond)
	}
}

func openPluginProcessThread(pid uint32) (windows.Handle, error) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	if err := windows.Thread32First(snapshot, &entry); err != nil {
		return 0, err
	}
	for {
		if entry.OwnerProcessID == pid {
			return windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
		}
		if err := windows.Thread32Next(snapshot, &entry); err != nil {
			if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
				return 0, errPluginProcessThreadNotFound
			}
			return 0, err
		}
	}
}

func failStartedPluginProcess(cmd *exec.Cmd, tree *windowsPluginProcessTree, cause error) error {
	// The process is still suspended here, so it has not run plugin code or
	// spawned descendants. Kill and reap it before reporting setup failure.
	killErr := cmd.Process.Kill()
	tree.close()
	_ = cmd.Wait()
	if killErr != nil && !errors.Is(killErr, os.ErrProcessDone) {
		cause = errors.Join(cause, fmt.Errorf("kill unmanaged plugin process: %w", killErr))
	}
	return cause
}

func (p *windowsPluginProcessTree) terminate(_ bool) {
	p.close()
}

func (p *windowsPluginProcessTree) close() {
	if p == nil {
		return
	}
	p.once.Do(func() {
		_ = windows.CloseHandle(p.job)
	})
}
