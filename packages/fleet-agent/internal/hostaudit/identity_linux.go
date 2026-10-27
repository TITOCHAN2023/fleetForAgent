//go:build linux

package hostaudit

import (
	"os"
	"strconv"
	"strings"
)

func Identity(pid int) (ProcessIdentity, error) {
	p := ProcessIdentity{PID: pid}
	boot, e := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if e != nil {
		return p, e
	}
	p.BootID = strings.TrimSpace(string(boot))
	b, e := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if e != nil {
		return p, e
	}
	return identityStat(p, string(b))
}
func identityStat(p ProcessIdentity, stat string) (ProcessIdentity, error) {
	end := strings.LastIndex(stat, ")")
	if end < 0 {
		return p, identityError(p.PID)
	}
	f := strings.Fields(stat[end+1:])
	if len(f) < 20 {
		return p, identityError(p.PID)
	}
	p.StartID = f[19]
	return p, nil
}
