//go:build darwin

package keepalive

import (
	"log"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"time"
)

// macOS: caffeinate -i is Apple's wrapper around
// IOPMAssertion Type PreventUserIdleSystemSleep.
// Screen can lock. Idle system sleep cannot. Lid-close still sleeps —
// that is a different assertion and we do not take it.
func StartLoop() {
	go darwinKeepAlive()
}

func darwinKeepAlive() {
	var (
		mu  sync.Mutex
		cmd *exec.Cmd
	)
	stop := func() {
		mu.Lock()
		defer mu.Unlock()
		if cmd == nil || cmd.Process == nil {
			return
		}
		_ = cmd.Process.Kill()
		cmd = nil
	}
	start := func() {
		mu.Lock()
		defer mu.Unlock()
		if cmd != nil && cmd.Process != nil {
			return
		}
		c := exec.Command("caffeinate", "-i", "-m", "-w", strconv.Itoa(os.Getpid()))
		if err := c.Start(); err != nil {
			log.Printf("keepalive: caffeinate: %v", err)
			return
		}
		log.Printf("keepalive: holding idle-sleep (caffeinate pid=%d)", c.Process.Pid)
		cmd = c
		go func() {
			_ = c.Wait()
			mu.Lock()
			if cmd == c {
				cmd = nil
			}
			mu.Unlock()
		}()
	}
	for {
		if wantedKeepAlive.Load() {
			start()
		} else {
			stop()
		}
		time.Sleep(2 * time.Second)
	}
}
