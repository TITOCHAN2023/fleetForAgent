package main

import (
	"image"
	"image/color"
	"math"
)

const (
	cursorCanvas = 320
	cursorHotX   = 48
	cursorHotY   = 48
	cursorTrailN = 14
)

var (
	cursorFill   = color.RGBA{R: 252, G: 252, B: 255, A: 255}
	cursorLine   = color.RGBA{R: 18, G: 22, B: 28, A: 230}
	cursorGlow   = color.RGBA{R: 45, G: 212, B: 191, A: 90}
	cursorRipple = color.RGBA{R: 45, G: 212, B: 191, A: 220}
	cursorTrail  = color.RGBA{R: 45, G: 212, B: 191, A: 160}
)

// Arrow in glyph space, hotspot at (0,0).
var cursorPoly = []vec2{
	{0, 0}, {1.2, 18.5}, {5.4, 14.2}, {9.6, 24.8}, {13.2, 23.4}, {8.4, 12.6}, {14.8, 12.2},
}

type cursorFrame struct {
	X, Y       float64
	Angle      float64
	Pulse      float64
	Trail      []vec2
	Pressed    bool
}

func drawCursorOverlay(fr cursorFrame) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, cursorCanvas, cursorCanvas))
	origin := vec2{cursorHotX, cursorHotY}

	for i, p := range fr.Trail {
		if i == len(fr.Trail)-1 {
			continue
		}
		t := float64(i+1) / float64(len(fr.Trail))
		rel := vec2{p.X - fr.X + origin.X, p.Y - fr.Y + origin.Y}
		r := 2.2 + 3.2*t
		a := uint8(18 + 90*t)
		fillCircle(img, rel.X, rel.Y, r, color.RGBA{cursorTrail.R, cursorTrail.G, cursorTrail.B, a})
	}

	if fr.Pulse > 0.02 {
		pr := 10 + 26*fr.Pulse
		pa := uint8(200 * (1 - fr.Pulse))
		strokeCircle(img, origin.X, origin.Y, pr, 2.2, color.RGBA{cursorRipple.R, cursorRipple.G, cursorRipple.B, pa})
		if fr.Pulse < 0.55 {
			strokeCircle(img, origin.X, origin.Y, pr*0.55, 1.4, color.RGBA{252, 252, 255, uint8(90 * (1 - fr.Pulse))})
		}
	}

	scale := 1.18
	if fr.Pressed {
		scale = 0.86
	} else if fr.Pulse > 0 {
		scale = 1.18 - 0.32*fr.Pulse
	}
	glowR := 11 + 4*scale
	if fr.Pulse > 0 {
		glowR += 6 * fr.Pulse
	}
	fillCircle(img, origin.X+3, origin.Y+6, glowR, cursorGlow)

	pts := make([]vec2, len(cursorPoly))
	cs, sn := math.Cos(fr.Angle), math.Sin(fr.Angle)
	// Resting pose is the classic NW arrow; heading 0 means "up-left-ish".
	rest := -0.55
	cs, sn = math.Cos(fr.Angle+rest), math.Sin(fr.Angle+rest)
	for i, p := range cursorPoly {
		x, y := p.X*scale, p.Y*scale
		pts[i] = vec2{
			origin.X + x*cs - y*sn,
			origin.Y + x*sn + y*cs,
		}
	}
	fillPoly(img, pts, cursorFill)
	strokePoly(img, pts, 1.35, cursorLine)
	return img
}

func fillCircle(img *image.RGBA, cx, cy, r float64, c color.RGBA) {
	if r <= 0 {
		return
	}
	minX := maxInt(0, int(cx-r-1))
	maxX := minInt(img.Bounds().Dx()-1, int(cx+r+1))
	minY := maxInt(0, int(cy-r-1))
	maxY := minInt(img.Bounds().Dy()-1, int(cy+r+1))
	r2 := r * r
	for y := minY; y <= maxY; y++ {
		for x := minX; x <= maxX; x++ {
			dx := float64(x) + 0.5 - cx
			dy := float64(y) + 0.5 - cy
			if dx*dx+dy*dy <= r2 {
				blendAt(img, x, y, c)
			}
		}
	}
}

func strokeCircle(img *image.RGBA, cx, cy, r, width float64, c color.RGBA) {
	if r <= 0 {
		return
	}
	outer := r + width/2
	inner := r - width/2
	if inner < 0 {
		inner = 0
	}
	minX := maxInt(0, int(cx-outer-1))
	maxX := minInt(img.Bounds().Dx()-1, int(cx+outer+1))
	minY := maxInt(0, int(cy-outer-1))
	maxY := minInt(img.Bounds().Dy()-1, int(cy+outer+1))
	o2, i2 := outer*outer, inner*inner
	for y := minY; y <= maxY; y++ {
		for x := minX; x <= maxX; x++ {
			dx := float64(x) + 0.5 - cx
			dy := float64(y) + 0.5 - cy
			d := dx*dx + dy*dy
			if d <= o2 && d >= i2 {
				blendAt(img, x, y, c)
			}
		}
	}
}

func fillPoly(img *image.RGBA, pts []vec2, c color.RGBA) {
	if len(pts) < 3 {
		return
	}
	minY, maxY := pts[0].Y, pts[0].Y
	for _, p := range pts[1:] {
		if p.Y < minY {
			minY = p.Y
		}
		if p.Y > maxY {
			maxY = p.Y
		}
	}
	y0 := maxInt(0, int(math.Floor(minY)))
	y1 := minInt(img.Bounds().Dy()-1, int(math.Ceil(maxY)))
	n := len(pts)
	for y := y0; y <= y1; y++ {
		yy := float64(y) + 0.5
		xs := make([]float64, 0, n)
		for i := 0; i < n; i++ {
			a, b := pts[i], pts[(i+1)%n]
			if (a.Y <= yy && b.Y > yy) || (b.Y <= yy && a.Y > yy) {
				t := (yy - a.Y) / (b.Y - a.Y)
				xs = append(xs, a.X+(b.X-a.X)*t)
			}
		}
		for i := 0; i < len(xs); i++ {
			for j := i + 1; j < len(xs); j++ {
				if xs[j] < xs[i] {
					xs[i], xs[j] = xs[j], xs[i]
				}
			}
		}
		for i := 0; i+1 < len(xs); i += 2 {
			x0 := maxInt(0, int(math.Floor(xs[i])))
			x1 := minInt(img.Bounds().Dx()-1, int(math.Ceil(xs[i+1])))
			for x := x0; x <= x1; x++ {
				blendAt(img, x, y, c)
			}
		}
	}
}

func strokePoly(img *image.RGBA, pts []vec2, width float64, c color.RGBA) {
	n := len(pts)
	for i := 0; i < n; i++ {
		strokeLine(img, pts[i], pts[(i+1)%n], width, c)
	}
}

func strokeLine(img *image.RGBA, a, b vec2, width float64, c color.RGBA) {
	dx, dy := b.X-a.X, b.Y-a.Y
	n := int(math.Hypot(dx, dy)*1.6) + 1
	r := width
	for i := 0; i <= n; i++ {
		t := float64(i) / float64(n)
		fillCircle(img, a.X+dx*t, a.Y+dy*t, r, c)
	}
}

func blendAt(img *image.RGBA, x, y int, c color.RGBA) {
	if x < 0 || y < 0 || x >= img.Bounds().Dx() || y >= img.Bounds().Dy() || c.A == 0 {
		return
	}
	i := img.PixOffset(x, y)
	sa := float64(c.A) / 255
	img.Pix[i+0] = uint8(float64(c.R)*sa + float64(img.Pix[i+0])*(1-sa))
	img.Pix[i+1] = uint8(float64(c.G)*sa + float64(img.Pix[i+1])*(1-sa))
	img.Pix[i+2] = uint8(float64(c.B)*sa + float64(img.Pix[i+2])*(1-sa))
	da := float64(img.Pix[i+3]) / 255
	outA := sa + da*(1-sa)
	img.Pix[i+3] = uint8(outA * 255)
}

func premultiplyBGRA(src *image.RGBA) []byte {
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	out := make([]byte, w*h*4)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			i := src.PixOffset(x, y)
			a := uint32(src.Pix[i+3])
			o := (y*w + x) * 4
			out[o+0] = byte(uint32(src.Pix[i+2]) * a / 255)
			out[o+1] = byte(uint32(src.Pix[i+1]) * a / 255)
			out[o+2] = byte(uint32(src.Pix[i+0]) * a / 255)
			out[o+3] = src.Pix[i+3]
		}
	}
	return out
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
