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
	"time"
)

const pluginPeerProcessWaitMax = 2 * time.Second

type pluginPeerIO interface {
	WriteControl(any) error
	WriteData([]byte) error
	ReadRecord() (pluginPeerRecord, error)
	Wait() error
	Cancel()
	Abort()
}

type processPluginPeer struct {
	cmd     *exec.Cmd
	ctx     context.Context
	stdin   ioWriteCloser
	stdout  *bufio.Reader
	stderr  *capBuffer
	writeMu sync.Mutex
	wait    sync.Once
	stop    sync.Once
	done    chan struct{}
	waitErr error
	waitFn  func() error
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
	configurePluginProcess(cmd)
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
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return installedPlugin{}, nil, err
	}
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
	return readPluginPeerRecord(p.stdout)
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

func (p *processPluginPeer) Cancel() {
	p.cancelWithin(500*time.Millisecond, 250*time.Millisecond, pluginPeerProcessWaitMax)
}

func (p *processPluginPeer) cancelWithin(gracefulWait, terminateWait, forceWait time.Duration) {
	p.stop.Do(func() {
		// A plugin can stop reading stdin while another DATA write owns writeMu.
		// Cancellation must still reach the process-tree kill path on schedule.
		go func() { _ = p.WriteControl(map[string]any{"v": 1, "type": "cancel"}) }()
		if p.waitForExit(gracefulWait) {
			return
		}
		_ = p.stdin.Close()
		terminatePluginProcessTree(p.cmd, false)
		if p.waitForExit(terminateWait) {
			return
		}
		terminatePluginProcessTree(p.cmd, true)
		_ = p.waitForExit(forceWait)
	})
}

func (p *processPluginPeer) Abort() {
	p.abortWithin(pluginPeerProcessWaitMax)
}

func (p *processPluginPeer) abortWithin(forceWait time.Duration) {
	p.stop.Do(func() {
		_ = p.stdin.Close()
		terminatePluginProcessTree(p.cmd, true)
		_ = p.waitForExit(forceWait)
	})
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
