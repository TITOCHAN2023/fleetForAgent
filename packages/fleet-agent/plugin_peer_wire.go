package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	pluginPeerHeaderBytes = 12
	pluginPeerControlMax  = 64 << 10
	pluginPeerDataMax     = 32 << 10
	pluginPeerRecordJSON  = byte(1)
	pluginPeerRecordData  = byte(2)
)

var pluginPeerMagic = [4]byte{'F', 'L', 'P', 'P'}

type pluginPeerRecord struct {
	Kind    byte
	Payload []byte
}

type pluginPeerControl struct {
	V      int             `json:"v"`
	Type   string          `json:"type"`
	Status string          `json:"status,omitempty"`
	Code   string          `json:"code,omitempty"`
	Error  string          `json:"error,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
}

func writePluginPeerRecord(w io.Writer, kind byte, payload []byte) error {
	limit := pluginPeerDataMax
	if kind == pluginPeerRecordJSON {
		limit = pluginPeerControlMax
	} else if kind != pluginPeerRecordData {
		return errors.New("unknown plugin peer record kind")
	}
	if len(payload) > limit {
		return fmt.Errorf("plugin peer record exceeds %d bytes", limit)
	}
	header := make([]byte, pluginPeerHeaderBytes)
	copy(header[:4], pluginPeerMagic[:])
	header[4] = 1
	header[5] = kind
	binary.BigEndian.PutUint16(header[6:8], 0)
	binary.BigEndian.PutUint32(header[8:12], uint32(len(payload)))
	if _, err := w.Write(header); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

func writePluginPeerControl(w io.Writer, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return writePluginPeerRecord(w, pluginPeerRecordJSON, payload)
}

func readPluginPeerRecord(r *bufio.Reader) (pluginPeerRecord, error) {
	header := make([]byte, pluginPeerHeaderBytes)
	if _, err := io.ReadFull(r, header); err != nil {
		return pluginPeerRecord{}, err
	}
	if string(header[:4]) != string(pluginPeerMagic[:]) || header[4] != 1 || binary.BigEndian.Uint16(header[6:8]) != 0 {
		return pluginPeerRecord{}, errors.New("invalid plugin peer record header")
	}
	kind := header[5]
	limit := pluginPeerDataMax
	if kind == pluginPeerRecordJSON {
		limit = pluginPeerControlMax
	} else if kind != pluginPeerRecordData {
		return pluginPeerRecord{}, errors.New("unknown plugin peer record kind")
	}
	length := int(binary.BigEndian.Uint32(header[8:12]))
	if length > limit {
		return pluginPeerRecord{}, fmt.Errorf("plugin peer record exceeds %d bytes", limit)
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return pluginPeerRecord{}, err
	}
	return pluginPeerRecord{Kind: kind, Payload: payload}, nil
}

func decodePluginPeerControl(payload []byte) (pluginPeerControl, error) {
	var value pluginPeerControl
	if len(payload) == 0 || len(payload) > pluginPeerControlMax || json.Unmarshal(payload, &value) != nil || value.V != 1 || value.Type == "" {
		return pluginPeerControl{}, errors.New("invalid plugin peer control")
	}
	return value, nil
}
