//go:build windows

// testplugin is built only by the Windows Node integration test. The leader
// intentionally exits cleanly after acknowledging cancel while its descendant
// keeps running, which proves the Job host owns more than the leader PID.
package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"time"
)

const headerBytes = 12

type control struct {
	Type string `json:"type"`
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--descendant" {
		for {
			time.Sleep(time.Hour)
		}
	}
	pidFile := os.Getenv("FLEET_TEST_WINDOWS_DESCENDANT_PID")
	ignoreCancel := os.Getenv("FLEET_TEST_WINDOWS_IGNORE_CANCEL") == "1"
	if pidFile == "" {
		fmt.Fprintln(os.Stderr, "missing descendant PID path")
		os.Exit(2)
	}
	descendant := exec.Command(os.Args[0], "--descendant")
	if err := descendant.Start(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(3)
	}
	if err := os.WriteFile(pidFile, []byte(strconv.Itoa(descendant.Process.Pid)), 0o600); err != nil {
		_ = descendant.Process.Kill()
		fmt.Fprintln(os.Stderr, err)
		os.Exit(4)
	}

	for {
		record, err := readControl(os.Stdin)
		if err != nil {
			os.Exit(5)
		}
		switch record.Type {
		case "open":
			if err := writeStatus("ready"); err != nil {
				os.Exit(6)
			}
		case "cancel":
			if ignoreCancel {
				continue
			}
			if err := writeStatus("canceled"); err != nil {
				os.Exit(7)
			}
			// Do not wait for or terminate the descendant. The Job host must do it.
			os.Exit(0)
		}
	}
}

func readControl(reader io.Reader) (control, error) {
	header := make([]byte, headerBytes)
	if _, err := io.ReadFull(reader, header); err != nil {
		return control{}, err
	}
	if string(header[:4]) != "FLPP" || header[4] != 1 || header[5] != 1 {
		return control{}, fmt.Errorf("invalid FLPP header")
	}
	length := binary.BigEndian.Uint32(header[8:12])
	if length > 64<<10 {
		return control{}, fmt.Errorf("control too large")
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return control{}, err
	}
	var value control
	if err := json.Unmarshal(payload, &value); err != nil {
		return control{}, err
	}
	return value, nil
}

func writeStatus(status string) error {
	payload, err := json.Marshal(map[string]any{"v": 1, "type": "status", "status": status})
	if err != nil {
		return err
	}
	header := make([]byte, headerBytes)
	copy(header, "FLPP")
	header[4] = 1
	header[5] = 1
	binary.BigEndian.PutUint32(header[8:12], uint32(len(payload)))
	if _, err := os.Stdout.Write(header); err != nil {
		return err
	}
	_, err = os.Stdout.Write(payload)
	return err
}
