package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

type testPluginPeerStdin struct {
	closed atomic.Bool
}

type testPluginProcessTree struct {
	closed     atomic.Int32
	terminated atomic.Int32
}

func (t *testPluginProcessTree) terminate(bool) { t.terminated.Add(1) }
func (t *testPluginProcessTree) close()         { t.closed.Add(1) }

func (s *testPluginPeerStdin) Write(value []byte) (int, error) { return len(value), nil }
func (s *testPluginPeerStdin) Close() error {
	s.closed.Store(true)
	return nil
}

func TestPluginPeerWaitClosesManagedProcessTree(t *testing.T) {
	tree := &testPluginProcessTree{}
	p := &processPluginPeer{
		ctx: context.Background(), stdin: &testPluginPeerStdin{},
		stdout: bufio.NewReader(&bytes.Buffer{}), stderr: &capBuffer{max: 1024},
		done: make(chan struct{}), tree: tree, waitFn: func() error { return nil },
	}
	if err := p.Wait(); err != nil {
		t.Fatal(err)
	}
	if got := tree.closed.Load(); got != 1 {
		t.Fatalf("managed process tree closed %d times after leader exit; want 1", got)
	}
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

func TestPluginPeerCancelReceiptRequiresGracefulExit(t *testing.T) {
	t.Run("forced stop is not a receipt", func(t *testing.T) {
		release := make(chan struct{})
		p := &processPluginPeer{
			ctx: context.Background(), stdin: &testPluginPeerStdin{},
			stdout: bufio.NewReader(&bytes.Buffer{}), stderr: &capBuffer{max: 1024},
			done: make(chan struct{}), waitFn: func() error {
				<-release
				return nil
			},
		}
		if p.cancelWithin(10*time.Millisecond, 10*time.Millisecond, 10*time.Millisecond) {
			t.Fatal("forced process termination was reported as an applied FLPP cancel")
		}
		close(release)
		if !p.waitForExit(time.Second) {
			t.Fatal("process waiter did not finish after release")
		}
	})

	t.Run("clean exit after cancel is a receipt", func(t *testing.T) {
		p := &processPluginPeer{
			ctx: context.Background(), stdin: &testPluginPeerStdin{},
			stdout: bufio.NewReader(&bytes.Buffer{}), stderr: &capBuffer{max: 1024},
			done: make(chan struct{}), waitFn: func() error { return nil },
		}
		p.cancelSeen.Store(true)
		if !p.cancelWithin(time.Second, 10*time.Millisecond, 10*time.Millisecond) {
			t.Fatal("clean process exit after a written cancel did not produce a receipt")
		}
	})

	t.Run("non-zero exit after cancel is not a receipt", func(t *testing.T) {
		p := &processPluginPeer{
			ctx: context.Background(), stdin: &testPluginPeerStdin{},
			stdout: bufio.NewReader(&bytes.Buffer{}), stderr: &capBuffer{max: 1024},
			done: make(chan struct{}), waitFn: func() error { return errors.New("exit status 1") },
		}
		p.cancelSeen.Store(true)
		if p.cancelWithin(time.Second, 10*time.Millisecond, 10*time.Millisecond) {
			t.Fatal("non-zero process exit was reported as an applied FLPP cancel")
		}
	})
}

func TestPluginPeerCancelReceiptRequiresValidStatusVersion(t *testing.T) {
	for _, tc := range []struct {
		name    string
		payload string
		seen    bool
	}{
		{name: "missing version", payload: `{"type":"status","status":"canceled"}`},
		{name: "wrong version", payload: `{"v":2,"type":"status","status":"canceled"}`},
		{name: "valid", payload: `{"v":1,"type":"status","status":"canceled"}`, seen: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var wire bytes.Buffer
			if err := writePluginPeerRecord(&wire, pluginPeerRecordJSON, []byte(tc.payload)); err != nil {
				t.Fatal(err)
			}
			p := &processPluginPeer{stdout: bufio.NewReader(&wire)}
			if _, err := p.ReadRecord(); err != nil {
				t.Fatal(err)
			}
			if got := p.cancelSeen.Load(); got != tc.seen {
				t.Fatalf("cancelSeen=%v, want %v", got, tc.seen)
			}
		})
	}
}
