//go:build linux

package keepalive

import (
	"log"
	"os/exec"
	"syscall"
	"sync"
	"time"
)

// systemd-inhibit --what=idle:sleep is the Linux counterpart of
// caffeinate -i. Screen lock still happens. Lid-switch is not blocked.
func StartLoop() {
	go linuxKeepAlive()
}

func linuxKeepAlive() {
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
		bin, err := exec.LookPath("systemd-inhibit")
		if err != nil {
			log.Printf("keepalive: systemd-inhibit not found")
			return
		}
		c := exec.Command(bin,
			"--what=idle:sleep",
			"--who=Fleet Agent",
			"--why=Fleet Agent is enabled",
			"--mode=block",
			"tail", "-f", "/dev/null",
		)
		c.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
		if err := c.Start(); err != nil {
			log.Printf("keepalive: systemd-inhibit: %v", err)
			return
		}
		log.Printf("keepalive: holding idle-sleep (systemd-inhibit pid=%d)", c.Process.Pid)
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
