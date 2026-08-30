package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const pluginPeerProcessWaitMax = 2 * time.Second

type pluginPeerIO interface {
	WriteControl(any) error
	WriteData([]byte) error
	ReadRecord() (pluginPeerRecord, error)
	Wait() error
	Cancel() bool
	Abort()
}

type pluginProcessTree interface {
	terminate(force bool)
	close()
}

type processPluginPeer struct {
	cmd           *exec.Cmd
	tree          pluginProcessTree
	ctx           context.Context
	stdin         ioWriteCloser
	stdout        *bufio.Reader
	stderr        *capBuffer
	writeMu       sync.Mutex
	wait          sync.Once
	stop          sync.Once
	done          chan struct{}
	waitErr       error
	waitFn        func() error
	stopMode      string
	cancelApplied bool
	cancelSeen    atomic.Bool
	cancelDrain   sync.Once
}

// ioWriteCloser is intentionally smaller than io.WriteCloser so fake peers do
// not need to expose unrelated methods.
type ioWriteCloser interface {
	Write([]byte) (int, error)
	Close() error
}

func startPluginPeerProcess(ctx context.Context, pluginID, protocol, role, action string) (installedPlugin, pluginPeerIO, error) {
	meta, path, err := installedPluginForPeerAction(pluginID, protocol, role, action)
	if err != nil {
		return installedPlugin{}, nil, err
	}
	cmd := exec.Command(path)
	dir := filepath.Dir(path)
	cmd.Env = append(os.Environ(),
		"FLEET_PLUGIN_DATA_DIR="+filepath.Join(dir, "data"),
		"FLEET_PLUGIN_PEER=1",
		"FLEET_PLUGIN_ID="+meta.ID,
	)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return installedPlugin{}, nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return installedPlugin{}, nil, err
	}
	peer := &processPluginPeer{
		cmd: cmd, ctx: ctx, stdin: stdin,
		stdout: bufio.NewReaderSize(stdout, pluginPeerControlMax+pluginPeerHeaderBytes),
		stderr: &capBuffer{max: 256 << 10},
		done:   make(chan struct{}),
	}
	cmd.Stderr = peer.stderr
	tree, err := startPluginProcess(cmd)
	if err != nil {
		_ = stdin.Close()
		return installedPlugin{}, nil, err
	}
	peer.tree = tree
	go func() {
		select {
		case <-ctx.Done():
			peer.Abort()
		case <-peer.done:
		}
	}()
	return meta, peer, nil
}

func (p *processPluginPeer) WriteControl(value any) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	return writePluginPeerControl(p.stdin, value)
}

func (p *processPluginPeer) WriteData(value []byte) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	return writePluginPeerRecord(p.stdin, pluginPeerRecordData, value)
}

func (p *processPluginPeer) ReadRecord() (pluginPeerRecord, error) {
	record, err := readPluginPeerRecord(p.stdout)
	if err == nil && record.Kind == pluginPeerRecordJSON {
		control, controlErr := decodePluginPeerControl(record.Payload)
		if controlErr == nil && control.Type == "status" && control.Status == "canceled" {
			p.cancelSeen.Store(true)
		}
	}
	return record, err
}

func (p *processPluginPeer) drainCancellationStatus() {
	p.cancelDrain.Do(func() {
		go func() {
			for !p.cancelSeen.Load() {
				if _, err := p.ReadRecord(); err != nil {
					return
				}
			}
		}()
	})
}

func (p *processPluginPeer) Wait() error {
	if !p.waitForExit(pluginPeerProcessWaitMax) {
		return errors.New("plugin peer process wait timed out")
	}
	return p.waitErr
}

func (p *processPluginPeer) startWait() {
	p.wait.Do(func() {
		go func() {
			defer close(p.done)
			wait := p.waitFn
			if wait == nil {
				wait = p.cmd.Wait
			}
			err := wait()
			if p.tree != nil {
				p.tree.close()
			}
			if err == nil {
				return
			}
			if p.ctx.Err() != nil {
				p.waitErr = fmt.Errorf("plugin peer canceled: %w", p.ctx.Err())
				return
			}
			stderr := strings.TrimSpace(p.stderr.String())
			if stderr == "" {
				p.waitErr = fmt.Errorf("plugin peer failed: %w", err)
			} else {
				p.waitErr = fmt.Errorf("plugin peer failed: %w: %s", err, stderr)
			}
		}()
	})
}

func (p *processPluginPeer) waitForExit(timeout time.Duration) bool {
	p.startWait()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-p.done:
		return true
	case <-timer.C:
		return false
	}
}

func (p *processPluginPeer) Cancel() bool {
	p.stop.Do(func() {
		p.stopMode = "cancel"
		p.cancelApplied = p.cancelWithin(500*time.Millisecond, 250*time.Millisecond, pluginPeerProcessWaitMax)
	})
	return p.stopMode == "cancel" && p.cancelApplied
}

func (p *processPluginPeer) cancelWithin(gracefulWait, terminateWait, forceWait time.Duration) bool {
	// A plugin can stop reading stdin while another DATA write owns writeMu.
	// Cancellation must still reach the process-tree kill path on schedule. A
	// forced stop is cleanup, not proof that the FLPP cancel frame was applied.
	writeDone := make(chan error, 1)
	go func() { writeDone <- p.WriteControl(map[string]any{"v": 1, "type": "cancel"}) }()
	graceful := p.waitForExit(gracefulWait)
	cleanExit := graceful && p.waitErr == nil
	if !graceful {
		_ = p.stdin.Close()
		if p.tree != nil {
			p.tree.terminate(false)
		}
		if !p.waitForExit(terminateWait) {
			if p.tree != nil {
				p.tree.terminate(true)
			}
			_ = p.waitForExit(forceWait)
		}
	}
	// The plugin contract owns one process tree, not only its group leader.
	// A leader may exit cleanly after acknowledging cancel while leaving helpers
	// behind. Sweep the group regardless of the leader's exit status; this is
	// cleanup only and does not turn a forced/non-zero exit into a receipt.
	if p.tree != nil {
		p.tree.terminate(true)
	}
	writeTimer := time.NewTimer(terminateWait)
	defer writeTimer.Stop()
	select {
	case err := <-writeDone:
		if err != nil || !cleanExit {
			return false
		}
		deadline := time.Now().Add(50 * time.Millisecond)
		for !p.cancelSeen.Load() && time.Now().Before(deadline) {
			time.Sleep(time.Millisecond)
		}
		return p.cancelSeen.Load()
	case <-writeTimer.C:
		return false
	}
}

func (p *processPluginPeer) Abort() {
	p.stop.Do(func() {
		p.stopMode = "abort"
		p.abortWithin(pluginPeerProcessWaitMax)
	})
}

func (p *processPluginPeer) abortWithin(forceWait time.Duration) {
	_ = p.stdin.Close()
	if p.tree != nil {
		p.tree.terminate(true)
	}
	_ = p.waitForExit(forceWait)
}

func pluginPeerOpen(action string, input json.RawMessage, peer pluginPeerEndpoint) map[string]any {
	if len(input) == 0 {
		input = json.RawMessage(`{}`)
	}
	return map[string]any{
		"v": 1, "type": "open", "action": action, "input": input,
		"peer": map[string]any{"kind": peer.Kind, "id": peer.ID, "name": peer.Name},
	}
}
