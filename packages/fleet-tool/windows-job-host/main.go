//go:build windows

// fleet-tool-windows-job-host is the Windows process-tree owner for Fleet Tool
// plugins. It deliberately has no protocol of its own: the plugin inherits the
// host's standard handles, so FLPP bytes still travel directly between Node and
// the plugin.
package main

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	// PROC_THREAD_ATTRIBUTE_JOB_LIST is available on the Windows 10 baseline.
	// Passing the Job in STARTUPINFOEX removes the unsafe Create-then-Assign
	// interval: the process is born suspended and already belongs to the Job.
	procThreadAttributeJobList = 0x0002000d

	jobObjectBasicAccountingInformation = 1
	hostFailureExitCode                 = 125
	jobTerminateCode                    = 126
	cleanupTimeout                      = 5 * time.Second
	infinite                            = 0xffffffff
)

type basicAccountingInformation struct {
	TotalUserTime             int64
	TotalKernelTime           int64
	ThisPeriodTotalUserTime   int64
	ThisPeriodTotalKernelTime int64
	TotalPageFaultCount       uint32
	TotalProcesses            uint32
	ActiveProcesses           uint32
	TotalTerminatedProcesses  uint32
}

type processResult struct {
	code uint32
	err  error
}

func main() {
	parentPID, pluginPath, err := parseArgs(os.Args[1:])
	if err != nil {
		fatal(err)
	}
	parent, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(parentPID))
	if err != nil {
		fatal(fmt.Errorf("open Fleet Tool process: %w", err))
	}
	defer windows.CloseHandle(parent)
	if signaled, err := handleSignaled(parent); err != nil {
		fatal(fmt.Errorf("check Fleet Tool process: %w", err))
	} else if signaled {
		fatal(errors.New("Fleet Tool process exited before plugin setup"))
	}

	job, err := newPluginJob()
	if err != nil {
		fatal(err)
	}
	defer windows.CloseHandle(job)

	process, thread, err := createManagedPlugin(job, pluginPath)
	if err != nil {
		fatal(err)
	}
	defer windows.CloseHandle(process)
	defer func() {
		if thread != 0 {
			windows.CloseHandle(thread)
		}
	}()

	if signaled, err := handleSignaled(parent); err != nil {
		fatalManaged(job, fmt.Errorf("recheck Fleet Tool process: %w", err))
	} else if signaled {
		fatalManaged(job, errors.New("Fleet Tool process exited during plugin setup"))
	}
	previous, err := windows.ResumeThread(thread)
	if err != nil {
		fatalManaged(job, fmt.Errorf("resume managed plugin process: %w", err))
	}
	if previous != 1 {
		fatalManaged(job, fmt.Errorf("unexpected primary thread suspend count %d", previous))
	}
	windows.CloseHandle(thread)
	thread = 0

	processDone := make(chan processResult, 1)
	go func() { processDone <- waitProcess(process) }()
	parentDone := make(chan error, 1)
	go func() { parentDone <- waitHandle(parent, infinite) }()

	select {
	case result := <-processDone:
		if result.err != nil {
			fatalManaged(job, fmt.Errorf("wait for plugin process: %w", result.err))
		}
		if err := terminateAndDrain(job); err != nil {
			fatal(fmt.Errorf("clean plugin process tree: %w", err))
		}
		os.Exit(normalizeExitCode(result.code))
	case waitErr := <-parentDone:
		if waitErr != nil {
			fmt.Fprintf(os.Stderr, "fleet plugin host: monitor Fleet Tool process: %v\n", waitErr)
		}
		if cleanupErr := terminateAndDrain(job); cleanupErr != nil {
			// Do not wait on a leader that cleanup failed to terminate. Exiting
			// closes the last Job handle, so KILL_ON_JOB_CLOSE remains the final
			// fail-safe instead of turning this supervisor into an orphan.
			fatal(fmt.Errorf("clean plugin process tree after Fleet Tool exit: %w", cleanupErr))
		}
		<-processDone
		os.Exit(hostFailureExitCode)
	}
}

func parseArgs(args []string) (int, string, error) {
	if len(args) != 4 || args[0] != "--parent-pid" || args[2] != "--" || args[3] == "" {
		return 0, "", errors.New("usage: fleet-tool-windows-job-host --parent-pid PID -- PLUGIN.exe")
	}
	pid, err := strconv.Atoi(args[1])
	if err != nil || pid <= 0 {
		return 0, "", errors.New("invalid Fleet Tool parent PID")
	}
	return pid, args[3], nil
}

func newPluginJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, fmt.Errorf("create plugin process Job: %w", err)
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		windows.CloseHandle(job)
		return 0, fmt.Errorf("set kill-on-close Job limit: %w", err)
	}
	return job, nil
}

func createManagedPlugin(job windows.Handle, pluginPath string) (windows.Handle, windows.Handle, error) {
	stdin, err := duplicateInheritable(windows.Handle(os.Stdin.Fd()))
	if err != nil {
		return 0, 0, fmt.Errorf("duplicate plugin stdin: %w", err)
	}
	defer windows.CloseHandle(stdin)
	stdout, err := duplicateInheritable(windows.Handle(os.Stdout.Fd()))
	if err != nil {
		return 0, 0, fmt.Errorf("duplicate plugin stdout: %w", err)
	}
	defer windows.CloseHandle(stdout)
	stderr, err := duplicateInheritable(windows.Handle(os.Stderr.Fd()))
	if err != nil {
		return 0, 0, fmt.Errorf("duplicate plugin stderr: %w", err)
	}
	defer windows.CloseHandle(stderr)

	attributes, err := windows.NewProcThreadAttributeList(2)
	if err != nil {
		return 0, 0, fmt.Errorf("allocate plugin process attributes: %w", err)
	}
	defer attributes.Delete()
	jobs := []windows.Handle{job}
	if err := attributes.Update(
		procThreadAttributeJobList,
		unsafe.Pointer(&jobs[0]),
		unsafe.Sizeof(jobs[0]),
	); err != nil {
		return 0, 0, fmt.Errorf("attach Job-list process attribute: %w", err)
	}
	handles := []windows.Handle{stdin, stdout, stderr}
	if err := attributes.Update(
		windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
		unsafe.Pointer(&handles[0]),
		uintptr(len(handles))*unsafe.Sizeof(handles[0]),
	); err != nil {
		return 0, 0, fmt.Errorf("attach standard-handle process attribute: %w", err)
	}

	application, err := windows.UTF16PtrFromString(pluginPath)
	if err != nil {
		return 0, 0, fmt.Errorf("encode plugin path: %w", err)
	}
	commandLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine([]string{pluginPath}))
	if err != nil {
		return 0, 0, fmt.Errorf("encode plugin command line: %w", err)
	}
	startup := windows.StartupInfoEx{
		StartupInfo: windows.StartupInfo{
			Cb:        uint32(unsafe.Sizeof(windows.StartupInfoEx{})),
			Flags:     windows.STARTF_USESTDHANDLES,
			StdInput:  stdin,
			StdOutput: stdout,
			StdErr:    stderr,
		},
		ProcThreadAttributeList: attributes.List(),
	}
	info := windows.ProcessInformation{}
	flags := uint32(
		windows.CREATE_SUSPENDED |
			windows.CREATE_NEW_PROCESS_GROUP |
			windows.CREATE_NO_WINDOW |
			windows.CREATE_UNICODE_ENVIRONMENT |
			windows.EXTENDED_STARTUPINFO_PRESENT,
	)
	if err := windows.CreateProcess(
		application,
		commandLine,
		nil,
		nil,
		true,
		flags,
		nil,
		nil,
		&startup.StartupInfo,
		&info,
	); err != nil {
		return 0, 0, fmt.Errorf("create atomically managed plugin process: %w", err)
	}
	return info.Process, info.Thread, nil
}

func duplicateInheritable(source windows.Handle) (windows.Handle, error) {
	var target windows.Handle
	current := windows.CurrentProcess()
	if err := windows.DuplicateHandle(
		current,
		source,
		current,
		&target,
		0,
		true,
		windows.DUPLICATE_SAME_ACCESS,
	); err != nil {
		return 0, err
	}
	return target, nil
}

func waitProcess(process windows.Handle) processResult {
	if err := waitHandle(process, infinite); err != nil {
		return processResult{err: err}
	}
	var code uint32
	if err := windows.GetExitCodeProcess(process, &code); err != nil {
		return processResult{err: err}
	}
	return processResult{code: code}
}

func terminateAndDrain(job windows.Handle) error {
	active, err := activeProcesses(job)
	if err != nil {
		return err
	}
	if active != 0 {
		if err := windows.TerminateJobObject(job, jobTerminateCode); err != nil {
			return err
		}
	}
	deadline := time.Now().Add(cleanupTimeout)
	for {
		active, err = activeProcesses(job)
		if err != nil {
			return err
		}
		if active == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("Job still has %d active process(es) after %s", active, cleanupTimeout)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func activeProcesses(job windows.Handle) (uint32, error) {
	info := basicAccountingInformation{}
	var returned uint32
	if err := windows.QueryInformationJobObject(
		job,
		jobObjectBasicAccountingInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
		&returned,
	); err != nil {
		return 0, err
	}
	return info.ActiveProcesses, nil
}

func handleSignaled(handle windows.Handle) (bool, error) {
	result, err := windows.WaitForSingleObject(handle, 0)
	if err != nil {
		return false, err
	}
	switch result {
	case windows.WAIT_OBJECT_0:
		return true, nil
	case uint32(windows.WAIT_TIMEOUT):
		return false, nil
	default:
		return false, fmt.Errorf("unexpected wait result %#x", result)
	}
}

func waitHandle(handle windows.Handle, milliseconds uint32) error {
	result, err := windows.WaitForSingleObject(handle, milliseconds)
	if err != nil {
		return err
	}
	if result != windows.WAIT_OBJECT_0 {
		return fmt.Errorf("unexpected wait result %#x", result)
	}
	return nil
}

func normalizeExitCode(code uint32) int {
	if code <= 255 {
		return int(code)
	}
	return hostFailureExitCode
}

func fatalManaged(job windows.Handle, cause error) {
	if cleanupErr := terminateAndDrain(job); cleanupErr != nil {
		cause = errors.Join(cause, cleanupErr)
	}
	fatal(cause)
}

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "fleet plugin host: %v\n", err)
	os.Exit(hostFailureExitCode)
}
