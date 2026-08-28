package main

import (
	"bufio"
	"bytes"
	"testing"
)

func TestPluginPeerRecordRoundTrip(t *testing.T) {
	var wire bytes.Buffer
	if err := writePluginPeerControl(&wire, map[string]any{"v": 1, "type": "round_ready"}); err != nil {
		t.Fatal(err)
	}
	payload := bytes.Repeat([]byte{0xa5}, pluginPeerDataMax)
	if err := writePluginPeerRecord(&wire, pluginPeerRecordData, payload); err != nil {
		t.Fatal(err)
	}
	r := bufio.NewReader(&wire)
	controlRecord, err := readPluginPeerRecord(r)
	if err != nil {
		t.Fatal(err)
	}
	control, err := decodePluginPeerControl(controlRecord.Payload)
	if err != nil || control.Type != "round_ready" {
		t.Fatalf("control=%#v err=%v", control, err)
	}
	data, err := readPluginPeerRecord(r)
	if err != nil || data.Kind != pluginPeerRecordData || !bytes.Equal(data.Payload, payload) {
		t.Fatalf("data bytes=%d err=%v", len(data.Payload), err)
	}
}

func TestPluginPeerRecordBounds(t *testing.T) {
	var wire bytes.Buffer
	if err := writePluginPeerRecord(&wire, pluginPeerRecordData, make([]byte, pluginPeerDataMax+1)); err == nil {
		t.Fatal("oversized peer data accepted")
	}
	if err := writePluginPeerRecord(&wire, 99, nil); err == nil {
		t.Fatal("unknown record kind accepted")
	}
}
