package main

import (
	"context"
	"log"
	"net"
	"net/http"
	"os"
	"time"
)

// The settings API binds to loopback, but on a shared host every local account
// can reach loopback. Origin/Host checks stop browsers, not other users: they
// could squat the port before the daemon starts (and receive the CLI's token),
// or POST /api/update with their own binary and checksum. Where the OS can tell
// us who owns the other end of a loopback socket, both sides insist on it being
// this user (or root, who can read our files anyway).

func loopbackUIDAllowed(uid int) bool {
	return uid == os.Getuid() || uid == 0
}

// loopbackPeerAllowed reports whether the process on the far end of c runs as
// this user. Platforms without a lookup return ok=false and are allowed.
func loopbackPeerAllowed(c net.Conn) bool {
	uid, ok := loopbackPeerUID(c)
	if !ok {
		return !loopbackOwnerEnforced
	}
	return loopbackUIDAllowed(uid)
}

// ownerOnlyListener drops settings connections from other local users before
// any HTTP is read.
type ownerOnlyListener struct {
	net.Listener
}

func (l ownerOnlyListener) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if loopbackPeerAllowed(c) {
			return c, nil
		}
		log.Printf("warn settings: dropped connection from another local user (%s)", c.RemoteAddr())
		_ = c.Close()
	}
}

// ownerCheckedDial refuses to talk to a settings server that another local
// user is running on our port, so the CLI never hands it a Hub token.
func ownerCheckedDial(ctx context.Context, network, addr string) (net.Conn, error) {
	d := net.Dialer{Timeout: 2 * time.Second}
	c, err := d.DialContext(ctx, network, addr)
	if err != nil {
		return nil, err
	}
	if !loopbackPeerAllowed(c) {
		_ = c.Close()
		return nil, errForeignSettingsOwner
	}
	return c, nil
}

// settingsClient is the CLI's client for the local settings API.
func settingsClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout:   timeout,
		Transport: &http.Transport{Proxy: nil, DialContext: ownerCheckedDial, DisableKeepAlives: true},
	}
}

type foreignOwnerError struct{}

func (foreignOwnerError) Error() string {
	return "fleet settings port is held by another local user; refusing to talk to it"
}

var errForeignSettingsOwner error = foreignOwnerError{}
