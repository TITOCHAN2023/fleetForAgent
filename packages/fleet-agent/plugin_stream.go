package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// pluginStream is a long-running plugin process whose stdio carries file bytes.
// Only the first control line is JSON. The Agent must never buffer the payload.
type pluginStream struct {
	cmd     *exec.Cmd
	ctx     context.Context
	stdin   io.WriteCloser
	stdout  *bufio.Reader
	stderr  *capBuffer
	wait    sync.Once
	waitErr error
}

// startPluginStream starts a trusted plugin in streaming mode. stdin receives
// one bounded JSON control line and then remains attached for raw bytes. stdout
// remains unbounded: source actions emit one bounded manifest line followed by
// file bytes; target actions emit bounded NDJSON progress events.
func startPluginStream(ctx context.Context, pluginID, action string, input json.RawMessage) (*pluginStream, error) {
	meta, path, err := installedPluginForAction(pluginID, action)
	if err != nil {
		return nil, err
	}
	if pluginID != "fleet.transfer" {
		return nil, errors.New("streaming is only supported by fleet.transfer")
	}
	if len(input) == 0 {
		input = json.RawMessage(`{}`)
	}
	if !json.Valid(input) {
		return nil, errors.New("invalid plugin stream input")
	}
	payload, err := json.Marshal(map[string]any{"v": 1, "action": action, "input": input})
	if err != nil {
		return nil, err
	}
	if len(payload)+1 > pluginStreamLine {
		return nil, errors.New("plugin stream control line exceeds 64 KiB")
	}
	cmd := exec.CommandContext(ctx, path)
	dir := filepath.Dir(path)
	cmd.Env = append(os.Environ(),
		"FLEET_PLUGIN_DATA_DIR="+filepath.Join(dir, "data"),
		"FLEET_PLUGIN_STREAM=1",
		"FLEET_PLUGIN_ID="+meta.ID,
	)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	stream := &pluginStream{
		cmd:    cmd,
		ctx:    ctx,
		stdin:  stdin,
		stdout: bufio.NewReaderSize(stdout, pluginStreamLine+1),
		stderr: &capBuffer{max: 256 << 10},
	}
	cmd.Stderr = stream.stderr
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return nil, err
	}
	payload = append(payload, '\n')
	if _, err := stdin.Write(payload); err != nil {
		_ = stream.Close()
		return nil, fmt.Errorf("write plugin stream control line: %w", err)
	}
	return stream, nil
}

func (s *pluginStream) Stdin() io.WriteCloser { return s.stdin }

func (s *pluginStream) Stdout() *bufio.Reader { return s.stdout }

func (s *pluginStream) ReadJSONLine(dst any) error {
	line, err := readPluginStreamLine(s.stdout)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(line, dst); err != nil {
		return fmt.Errorf("invalid plugin stream JSON line: %w", err)
	}
	return nil
}

func readPluginStreamLine(r *bufio.Reader) ([]byte, error) {
	line, err := r.ReadSlice('\n')
	if errors.Is(err, bufio.ErrBufferFull) || len(line) > pluginStreamLine {
		return nil, errors.New("plugin stream JSON line exceeds 64 KiB")
	}
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	line = bytes.TrimSpace(line)
	if len(line) == 0 {
		if errors.Is(err, io.EOF) {
			return nil, io.EOF
		}
		return nil, errors.New("empty plugin stream JSON line")
	}
	return line, nil
}

func (s *pluginStream) Wait() error {
	s.wait.Do(func() {
		err := s.cmd.Wait()
		if err == nil {
			return
		}
		if s.ctx.Err() != nil {
			s.waitErr = fmt.Errorf("plugin stream canceled: %w", s.ctx.Err())
			return
		}
		stderr := strings.TrimSpace(s.stderr.String())
		if stderr == "" {
			s.waitErr = fmt.Errorf("plugin stream failed: %w", err)
			return
		}
		s.waitErr = fmt.Errorf("plugin stream failed: %w: %s", err, stderr)
	})
	return s.waitErr
}

func (s *pluginStream) Close() error {
	_ = s.stdin.Close()
	if s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
	return s.Wait()
}
