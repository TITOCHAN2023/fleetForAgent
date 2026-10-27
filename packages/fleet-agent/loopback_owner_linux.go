//go:build linux

package main

import (
	"bufio"
	"encoding/binary"
	"encoding/hex"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"
)

// Linux can always answer, so an unknown peer is refused rather than trusted.
const loopbackOwnerEnforced = true

var procNetTCPFiles = []string{"/proc/net/tcp", "/proc/net/tcp6"}

// loopbackPeerUID finds the socket whose local end is c's remote end (and vice
// versa) in /proc/net/tcp{,6} and returns its owner. For an accepted server
// conn that is the client's socket; for a dialed client conn it is the
// server's accepted socket, whose uid is inherited from the listener.
func loopbackPeerUID(c net.Conn) (int, bool) {
	local, ok1 := tcpAddrPort(c.LocalAddr())
	remote, ok2 := tcpAddrPort(c.RemoteAddr())
	if !ok1 || !ok2 || !remote.Addr().IsLoopback() {
		return 0, false
	}
	// The peer's half of a fresh loopback handshake can lag our side by a
	// softirq; look again briefly before giving up.
	for attempt := 0; attempt < 3; attempt++ {
		for _, path := range procNetTCPFiles {
			if uid, ok := procNetTCPOwner(path, remote, local); ok {
				return uid, true
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	return 0, false
}

func tcpAddrPort(a net.Addr) (netip.AddrPort, bool) {
	ta, ok := a.(*net.TCPAddr)
	if !ok {
		return netip.AddrPort{}, false
	}
	ap := ta.AddrPort()
	return netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port()), true
}

func procNetTCPOwner(path string, local, remote netip.AddrPort) (int, bool) {
	f, err := os.Open(path)
	if err != nil {
		return 0, false
	}
	defer f.Close()
	return scanProcNetTCP(bufio.NewScanner(f), local, remote)
}

func scanProcNetTCP(sc *bufio.Scanner, local, remote netip.AddrPort) (int, bool) {
	first := true
	for sc.Scan() {
		if first {
			first = false
			continue
		}
		fields := strings.Fields(sc.Text())
		if len(fields) < 10 {
			continue
		}
		l, ok1 := parseProcNetAddr(fields[1])
		r, ok2 := parseProcNetAddr(fields[2])
		if !ok1 || !ok2 || l != local || r != remote {
			continue
		}
		// Orphaned sockets (including FIN_WAIT2/TIME_WAIT) may report UID 0
		// after their owning file has gone. That is not evidence of root.
		inode, err := strconv.ParseUint(fields[9], 10, 64)
		if err != nil || inode == 0 {
			return 0, false
		}
		uid, err := strconv.Atoi(fields[7])
		if err != nil {
			return 0, false
		}
		return uid, true
	}
	return 0, false
}

// parseProcNetAddr decodes "0100007F:4642": the address is stored as 32-bit
// words in host byte order, the port as big-endian hex.
func parseProcNetAddr(s string) (netip.AddrPort, bool) {
	host, port, ok := strings.Cut(s, ":")
	if !ok {
		return netip.AddrPort{}, false
	}
	raw, err := hex.DecodeString(host)
	if err != nil || (len(raw) != 4 && len(raw) != 16) {
		return netip.AddrPort{}, false
	}
	for i := 0; i < len(raw); i += 4 {
		binary.BigEndian.PutUint32(raw[i:], binary.NativeEndian.Uint32(raw[i:]))
	}
	p, err := strconv.ParseUint(port, 16, 16)
	if err != nil {
		return netip.AddrPort{}, false
	}
	addr, _ := netip.AddrFromSlice(raw)
	return netip.AddrPortFrom(addr.Unmap(), uint16(p)), true
}
