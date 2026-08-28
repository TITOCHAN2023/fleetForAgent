package main

import (
	"bufio"
	"bytes"
	"context"
	"sync/atomic"
	"testing"
	"time"
)

type testPluginPeerStdin struct {
	closed atomic.Bool
}

func (s *testPluginPeerStdin) Write(value []byte) (int, error) { return len(value), nil }
func (s *testPluginPeerStdin) Close() error {
	s.closed.Store(true)
	return nil
}

func TestPluginPeerStopHasHardDeadlineWhenProcessWaitDoesNotReturn(t *testing.T) {
	for _, tc := range []struct {
		name string
		stop func(*processPluginPeer)
	}{
		{name: "cancel", stop: func(p *processPluginPeer) {
			p.cancelWithin(10*time.Millisecond, 10*time.Millisecond, 10*time.Millisecond)
		}},
		{name: "abort", stop: func(p *processPluginPeer) { p.abortWithin(10 * time.Millisecond) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			release := make(chan struct{})
			var waitCalls atomic.Int32
			stdin := &testPluginPeerStdin{}
			p := &processPluginPeer{
				ctx: context.Background(), stdin: stdin,
				stdout: bufio.NewReader(&bytes.Buffer{}), stderr: &capBuffer{max: 1024},
				done: make(chan struct{}),
				waitFn: func() error {
					waitCalls.Add(1)
					<-release
					return nil
				},
			}
			started := time.Now()
			tc.stop(p)
			if elapsed := time.Since(started); elapsed > 250*time.Millisecond {
				t.Fatalf("stop blocked for %s on a stuck process wait", elapsed)
			}
			if !stdin.closed.Load() {
				t.Fatal("stop returned without closing plugin stdin")
			}
			if p.waitForExit(5 * time.Millisecond) {
				t.Fatal("stuck process unexpectedly reported exit")
			}
			if waitCalls.Load() != 1 {
				t.Fatalf("timeout spawned %d process waiters; want exactly one", waitCalls.Load())
			}
			close(release)
			if !p.waitForExit(time.Second) {
				t.Fatal("single process waiter did not finish after release")
			}
			if waitCalls.Load() != 1 {
				t.Fatalf("cleanup leaked duplicate process waiters: %d", waitCalls.Load())
			}
		})
	}
}
