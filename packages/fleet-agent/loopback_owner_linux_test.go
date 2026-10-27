//go:build linux

package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseProcNetAddr(t *testing.T) {
	v4 := make([]byte, 4)
	binary.NativeEndian.PutUint32(v4, binary.BigEndian.Uint32([]byte{127, 0, 0, 1}))
	got, ok := parseProcNetAddr(fmt.Sprintf("%X:4642", v4))
	if !ok || got != netip.MustParseAddrPort("127.0.0.1:17986") {
		t.Fatalf("v4 = %v %v", got, ok)
	}
	ip6 := netip.MustParseAddr("::1").As16()
	v6 := make([]byte, 16)
	for i := 0; i < 16; i += 4 {
		binary.NativeEndian.PutUint32(v6[i:], binary.BigEndian.Uint32(ip6[i:]))
	}
	got, ok = parseProcNetAddr(fmt.Sprintf("%X:0050", v6))
	if !ok || got != netip.MustParseAddrPort("[::1]:80") {
		t.Fatalf("v6 = %v %v", got, ok)
	}
	if _, ok := parseProcNetAddr("zz:1"); ok {
		t.Fatal("bad hex accepted")
	}
}

func TestScanProcNetTCPMatchesExactPair(t *testing.T) {
	table := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
		"   0: 0100007F:4642 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 1 1\n" +
		"   1: 0100007F:4642 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1002        0 2 1\n"
	if binary.NativeEndian.Uint32([]byte{1, 0, 0, 0}) != 1 {
		t.Skip("fixture is little-endian")
	}
	local := netip.MustParseAddrPort("127.0.0.1:17986")
	remote := netip.MustParseAddrPort("127.0.0.1:40000")
	uid, ok := scanProcNetTCP(bufio.NewScanner(strings.NewReader(table)), local, remote)
	if !ok || uid != 1002 {
		t.Fatalf("uid=%d ok=%v", uid, ok)
	}
	if _, ok := scanProcNetTCP(bufio.NewScanner(strings.NewReader(table)), remote, local); ok {
		t.Fatal("reversed pair must not match")
	}
}

func TestLoopbackPeerUIDIsSelfBothWays(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err == nil {
			accepted <- c
		}
	}()
	client, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server := <-accepted
	defer server.Close()

	for name, c := range map[string]net.Conn{"server": server, "client": client} {
		uid, ok := loopbackPeerUID(c)
		if !ok || uid != os.Getuid() {
			t.Fatalf("%s side: uid=%d ok=%v want %d", name, uid, ok, os.Getuid())
		}
	}
}

// withForeignProcNet points the lookup at a table claiming every socket on
// port belongs to uid 4242, as if another account owned that end.
func withForeignProcNet(t *testing.T, port uint16) {
	t.Helper()
	if os.Getuid() == 4242 || os.Getuid() == 0 {
		t.Skip("fixture uid collides with test user")
	}
	if binary.NativeEndian.Uint32([]byte{1, 0, 0, 0}) != 1 {
		t.Skip("fixture is little-endian")
	}
	var b strings.Builder
	b.WriteString("  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n")
	for p := 1; p < 65536; p++ {
		if uint16(p) == port {
			continue
		}
		// Rows for both directions: client socket (local=p, rem=port) and
		// server socket (local=port, rem=p).
		fmt.Fprintf(&b, " 0: 0100007F:%04X 0100007F:%04X 01 0:0 0:0 0 4242 0 0 1\n", p, port)
		fmt.Fprintf(&b, " 0: 0100007F:%04X 0100007F:%04X 01 0:0 0:0 0 4242 0 0 1\n", port, p)
	}
	path := filepath.Join(t.TempDir(), "tcp")
	if err := os.WriteFile(path, []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	old := procNetTCPFiles
	procNetTCPFiles = []string{path}
	t.Cleanup(func() { procNetTCPFiles = old })
}

func TestOwnerOnlyListenerDropsForeignUser(t *testing.T) {
	raw, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := uint16(raw.Addr().(*net.TCPAddr).Port)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ok")
	})}
	go func() { _ = srv.Serve(ownerOnlyListener{raw}) }()
	defer srv.Close()
	url := "http://" + raw.Addr().String() + "/"

	plain := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}}
	res, err := plain.Get(url)
	if err != nil {
		t.Fatalf("same user refused: %v", err)
	}
	res.Body.Close()

	withForeignProcNet(t, port)
	if res, err := plain.Get(url); err == nil {
		res.Body.Close()
		t.Fatalf("foreign user got %s", res.Status)
	}
}

func TestSettingsClientRefusesForeignServer(t *testing.T) {
	raw, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	go func() {
		for {
			c, err := raw.Accept()
			if err != nil {
				return
			}
			_, _ = io.WriteString(c, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
			_ = c.Close()
		}
	}()
	withForeignProcNet(t, uint16(raw.Addr().(*net.TCPAddr).Port))
	_, err = settingsClient(2*time.Second).Post("http://"+raw.Addr().String()+"/api/connect", "application/json", strings.NewReader(`{"token":"flt_1secret"}`))
	if err == nil || !errors.Is(err, errForeignSettingsOwner) {
		t.Fatalf("err = %v, want foreign owner refusal", err)
	}
	if _, err := ownerCheckedDial(context.Background(), "tcp", raw.Addr().String()); !errors.Is(err, errForeignSettingsOwner) {
		t.Fatalf("dial err = %v", err)
	}
}

func TestScanProcNetTCPRejectsOwnerlessRootRows(t *testing.T) {
	if binary.NativeEndian.Uint32([]byte{1, 0, 0, 0}) != 1 {
		t.Skip("fixture is little-endian")
	}
	local := netip.MustParseAddrPort("127.0.0.1:40000")
	remote := netip.MustParseAddrPort("127.0.0.1:17986")
	for _, state := range []string{"01", "05", "06"} {
		table := "header\n" + "0: 0100007F:9C40 0100007F:4642 " + state + " 0:0 0:0 0 0 0 0 1\n"
		if uid, ok := scanProcNetTCP(bufio.NewScanner(strings.NewReader(table)), local, remote); ok {
			t.Fatalf("ownerless %s row accepted as uid %d", state, uid)
		}
	}
	table := "header\n0: 0100007F:9C40 0100007F:4642 01 0:0 0:0 0 0 0 123 1\n"
	if uid, ok := scanProcNetTCP(bufio.NewScanner(strings.NewReader(table)), local, remote); !ok || uid != 0 {
		t.Fatalf("live root socket rejected: uid=%d ok=%v", uid, ok)
	}
}

// A client can queue a mutation and close before Accept checks its identity.
// Linux then reports UID 0 with no inode; queued bytes must not inherit trust.
func TestLoopbackPeerRejectsClosedSenderWithQueuedRequest(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	client, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = client.Write([]byte("queued")); err != nil {
		client.Close()
		t.Fatal(err)
	}
	if err = client.Close(); err != nil {
		t.Fatal(err)
	}
	server, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	b := make([]byte, 6)
	if _, err = io.ReadFull(server, b); err != nil {
		t.Fatal(err)
	}
	if uid, ok := loopbackPeerUID(server); ok {
		t.Fatalf("closed sender accepted as uid %d", uid)
	}
	if loopbackPeerAllowed(server) {
		t.Fatal("queued request from ownerless socket trusted")
	}
}
