package main

import (
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	fileChannelLabel     = "fleet-file-v1"
	fileFrameHeaderBytes = 16
	fileChunkBytes       = 32 << 10
	fileBufferHighWater  = 4 << 20
	fileBufferLowWater   = 1 << 20
	fileAckBytes         = 4 << 20
	fileFrameVersion     = byte(1)
	fileFrameData        = byte(1)
)

var fileFrameMagic = [4]byte{'F', 'L', 'T', 'F'}

type fileFrame struct {
	Offset  uint64
	Payload []byte
}

func encodeFileFrame(offset uint64, payload []byte) ([]byte, error) {
	if len(payload) > fileChunkBytes {
		return nil, fmt.Errorf("file frame exceeds %d bytes", fileChunkBytes)
	}
	frame := make([]byte, fileFrameHeaderBytes+len(payload))
	copy(frame[:4], fileFrameMagic[:])
	frame[4] = fileFrameVersion
	frame[5] = fileFrameData
	binary.BigEndian.PutUint16(frame[6:8], 0)
	binary.BigEndian.PutUint64(frame[8:16], offset)
	copy(frame[fileFrameHeaderBytes:], payload)
	return frame, nil
}

func decodeFileFrame(raw []byte) (fileFrame, error) {
	if len(raw) < fileFrameHeaderBytes || string(raw[:4]) != string(fileFrameMagic[:]) {
		return fileFrame{}, errors.New("invalid file frame magic")
	}
	if raw[4] != fileFrameVersion || raw[5] != fileFrameData {
		return fileFrame{}, errors.New("unsupported file frame")
	}
	if binary.BigEndian.Uint16(raw[6:8]) != 0 {
		return fileFrame{}, errors.New("unknown file frame flags")
	}
	payload := raw[fileFrameHeaderBytes:]
	if len(payload) > fileChunkBytes {
		return fileFrame{}, fmt.Errorf("file frame exceeds %d bytes", fileChunkBytes)
	}
	return fileFrame{Offset: binary.BigEndian.Uint64(raw[8:16]), Payload: payload}, nil
}
