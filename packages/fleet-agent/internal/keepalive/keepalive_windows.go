//go:build windows

package keepalive

import (
	"log"
	"runtime"
	"syscall"
	"time"
)

// SetThreadExecutionState is per-thread. Hold it on a pinned goroutine
// for the life of the process. ES_DISPLAY_REQUIRED is intentionally off:
// the lock screen may come up. ES_AWAYMODE_REQUIRED is off so the user
// can still choose Sleep from the Start menu.
func StartLoop() {
	go windowsKeepAlive()
}

func windowsKeepAlive() {
	runtime.LockOSThread()
	k32 := syscall.NewLazyDLL("kernel32.dll")
	set := k32.NewProc("SetThreadExecutionState")
	const (
		esSystemRequired = 0x00000001
		esContinuous     = 0x80000000
	)
	held := false
	apply := func(on bool) {
		var flags uintptr
		if on {
			flags = esContinuous | esSystemRequired
		} else {
			flags = esContinuous
		}
		r, _, err := set.Call(flags)
		if r == 0 {
			log.Printf("keepalive: SetThreadExecutionState: %v", err)
			return
		}
		if on && !held {
			log.Printf("keepalive: holding idle-sleep")
		}
		held = on
	}
	for {
		want := wantedKeepAlive.Load()
		if want != held {
			apply(want)
		} else if want {
			apply(true)
		}
		time.Sleep(2 * time.Second)
	}
}
