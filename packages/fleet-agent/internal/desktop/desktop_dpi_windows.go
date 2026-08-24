//go:build windows

package desktop

import "syscall"

func init() {
	user32 := syscall.NewLazyDLL("user32.dll")
	set := user32.NewProc("SetProcessDpiAwarenessContext")
	const perMonitorV2 = ^uintptr(3) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
	_, _, _ = set.Call(perMonitorV2)
}
