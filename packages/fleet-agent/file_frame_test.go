package main

import (
	"bytes"
	"testing"
)

func TestFileFrameRoundTrip(t *testing.T) {
	payload := bytes.Repeat([]byte{0xa5}, fileChunkBytes)
	raw, err := encodeFileFrame(1<<40+7, payload)
	if err != nil {
		t.Fatal(err)
	}
	frame, err := decodeFileFrame(raw)
	if err != nil {
		t.Fatal(err)
	}
	if frame.Offset != 1<<40+7 || !bytes.Equal(frame.Payload, payload) {
		t.Fatalf("unexpected frame: offset=%d bytes=%d", frame.Offset, len(frame.Payload))
	}
}

func TestFileFrameRejectsOversizedAndUnknownFrames(t *testing.T) {
	if _, err := encodeFileFrame(0, make([]byte, fileChunkBytes+1)); err == nil {
		t.Fatal("oversized payload accepted")
	}
	if _, err := decodeFileFrame([]byte("not-a-frame")); err == nil {
		t.Fatal("bad magic accepted")
	}
	raw, err := encodeFileFrame(0, []byte("ok"))
	if err != nil {
		t.Fatal(err)
	}
	raw[6] = 1
	if _, err := decodeFileFrame(raw); err == nil {
		t.Fatal("unknown flags accepted")
	}
}
