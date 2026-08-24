//go:build darwin

package desktop

import (
	"image/color"
	"testing"
)

func TestRGBAFromBGRAPreservesTopToBottomRows(t *testing.T) {
	src := []byte{
		0, 0, 255, 255, // top-left: red
		0, 255, 0, 255, // top-right: green
		255, 0, 0, 255, // bottom-left: blue
		255, 255, 255, 255, // bottom-right: white
	}

	img := rgbaFromBGRA(src, 2, 2)
	want := [][]color.RGBA{
		{{R: 255, A: 255}, {G: 255, A: 255}},
		{{B: 255, A: 255}, {R: 255, G: 255, B: 255, A: 255}},
	}
	for y := range want {
		for x := range want[y] {
			if got := img.RGBAAt(x, y); got != want[y][x] {
				t.Fatalf("pixel (%d,%d) = %#v, want %#v", x, y, got, want[y][x])
			}
		}
	}
}
