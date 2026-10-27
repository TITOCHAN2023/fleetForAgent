//go:build !linux

package main

import "net"

// macOS and Windows hosts are usually single-user; without a cheap lookup we
// keep the existing loopback + Origin/Host boundary there.
const loopbackOwnerEnforced = false

func loopbackPeerUID(net.Conn) (int, bool) { return 0, false }
