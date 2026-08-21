//go:build darwin || windows || linux

package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
)

func trayPNG(template bool) []byte {
	const n = 32
	img := image.NewRGBA(image.Rect(0, 0, n, n))
	fg := color.RGBA{0, 0, 0, 255}
	if !template {
		for y := 1; y < n-1; y++ {
			for x := 1; x < n-1; x++ {
				dx, dy := x-16, y-16
				if dx*dx+dy*dy <= 14*14 {
					img.SetRGBA(x, y, color.RGBA{22, 26, 32, 255})
				}
			}
		}
		fg = color.RGBA{236, 238, 241, 255}
	}
	// Capital F, 5px stem + two bars.
	fill(img, 9, 7, 12, 25, fg)
	fill(img, 9, 7, 23, 11, fg)
	fill(img, 9, 14, 20, 18, fg)
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

func fill(img *image.RGBA, x0, y0, x1, y1 int, c color.RGBA) {
	for y := y0; y < y1; y++ {
		for x := x0; x < x1; x++ {
			img.SetRGBA(x, y, c)
		}
	}
}

func trayICO() []byte {
	png := trayPNG(false)
	buf := make([]byte, 22+len(png))
	buf[2] = 1
	buf[4] = 1
	buf[6] = 32
	buf[7] = 32
	binary.LittleEndian.PutUint16(buf[10:], 1)
	binary.LittleEndian.PutUint16(buf[12:], 32)
	binary.LittleEndian.PutUint32(buf[14:], uint32(len(png)))
	binary.LittleEndian.PutUint32(buf[18:], 22)
	copy(buf[22:], png)
	return buf
}
