package desktop

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
)

// Canonical model viewport and wire budget. Native 4K/5K never leaves the agent.
const (
	viewportLongDefault = 1280
	viewportLongMin     = 320
	viewportLongMax     = 1920
	jpegBudgetBytes     = 120 * 1024
	jpegQualityStart    = 78
	jpegQualityFloor    = 46
)

// DesktopFrame is the one screenshot object on WS, HTTP, and MCP.
// Viewport is what the model must click in. Display is the native capture.
type DesktopFrame struct {
	ID        string
	ViewportW int
	ViewportH int
	DisplayID string
	DisplayW  int
	DisplayH  int
	DPR       float64
	ScaleX    float64
	ScaleY    float64
	Origin    string
	MIME      string
	JPEG      []byte
	Bytes     int
	Digest    string
}

func fitBox(srcW, srcH, maxW, maxH int) (dstW, dstH int) {
	if srcW < 1 || srcH < 1 {
		return 1, 1
	}
	if maxW < viewportLongMin {
		maxW = viewportLongMin
	}
	if maxH < viewportLongMin {
		maxH = viewportLongMin
	}
	if maxW > viewportLongMax {
		maxW = viewportLongMax
	}
	if maxH > viewportLongMax {
		maxH = viewportLongMax
	}
	if srcW <= maxW && srcH <= maxH {
		return srcW, srcH
	}
	sx := float64(maxW) / float64(srcW)
	sy := float64(maxH) / float64(srcH)
	s := sx
	if sy < sx {
		s = sy
	}
	dstW = int(float64(srcW)*s + 0.5)
	dstH = int(float64(srcH)*s + 0.5)
	if dstW < 1 {
		dstW = 1
	}
	if dstH < 1 {
		dstH = 1
	}
	return dstW, dstH
}

func clampMax(v, lo, hi, fallback int) int {
	if v == 0 {
		return fallback
	}
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func toRGBA(src image.Image) *image.RGBA {
	if r, ok := src.(*image.RGBA); ok && r.Bounds().Min.Eq(image.Pt(0, 0)) {
		return r
	}
	b := src.Bounds()
	dst := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			dst.Set(x-b.Min.X, y-b.Min.Y, src.At(x, y))
		}
	}
	return dst
}

func scaleBilinear(src *image.RGBA, dw, dh int) *image.RGBA {
	sw, sh := src.Bounds().Dx(), src.Bounds().Dy()
	if sw == dw && sh == dh {
		return src
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	if dw == 1 && dh == 1 {
		dst.SetRGBA(0, 0, src.RGBAAt(0, 0))
		return dst
	}
	xDen := float64(dw)
	yDen := float64(dh)
	if dw > 1 {
		xDen = float64(dw - 1)
	}
	if dh > 1 {
		yDen = float64(dh - 1)
	}
	for y := 0; y < dh; y++ {
		fy := float64(y) * float64(sh-1) / yDen
		if dh == 1 {
			fy = 0
		}
		y0 := int(fy)
		y1 := y0 + 1
		if y1 >= sh {
			y1 = sh - 1
		}
		ty := fy - float64(y0)
		for x := 0; x < dw; x++ {
			fx := float64(x) * float64(sw-1) / xDen
			if dw == 1 {
				fx = 0
			}
			x0 := int(fx)
			x1 := x0 + 1
			if x1 >= sw {
				x1 = sw - 1
			}
			tx := fx - float64(x0)
			c00 := src.RGBAAt(x0, y0)
			c10 := src.RGBAAt(x1, y0)
			c01 := src.RGBAAt(x0, y1)
			c11 := src.RGBAAt(x1, y1)
			dst.SetRGBA(x, y, color.RGBA{
				R: lerp2(c00.R, c10.R, c01.R, c11.R, tx, ty),
				G: lerp2(c00.G, c10.G, c01.G, c11.G, tx, ty),
				B: lerp2(c00.B, c10.B, c01.B, c11.B, tx, ty),
				A: 255,
			})
		}
	}
	return dst
}

func lerp2(a, b, c, d uint8, tx, ty float64) uint8 {
	top := float64(a)*(1-tx) + float64(b)*tx
	bot := float64(c)*(1-tx) + float64(d)*tx
	v := top*(1-ty) + bot*ty
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return uint8(v + 0.5)
}

func encodeJPEGBudget(img image.Image, budget int) (data []byte, w, h, q int, err error) {
	if budget < 8*1024 {
		budget = 8 * 1024
	}
	cur := img
	var last []byte
	lastQ := jpegQualityFloor
	for round := 0; round < 6; round++ {
		for q = jpegQualityStart; q >= jpegQualityFloor; q -= 8 {
			var buf bytes.Buffer
			if err = jpeg.Encode(&buf, cur, &jpeg.Options{Quality: q}); err != nil {
				return nil, 0, 0, 0, err
			}
			last = buf.Bytes()
			lastQ = q
			if len(last) <= budget {
				return last, cur.Bounds().Dx(), cur.Bounds().Dy(), q, nil
			}
		}
		cb := cur.Bounds()
		nw, nh := fitBox(cb.Dx(), cb.Dy(), cb.Dx()*85/100, cb.Dy()*85/100)
		if nw >= cb.Dx() && nh >= cb.Dy() {
			break
		}
		cur = scaleBilinear(toRGBA(cur), nw, nh)
	}
	if last == nil {
		return nil, 0, 0, 0, fmt.Errorf("jpeg budget")
	}
	for len(last) > budget {
		cb := cur.Bounds()
		nw, nh := shrinkDims(cb.Dx(), cb.Dy(), 3, 4)
		if nw < 32 || nh < 32 {
			return nil, 0, 0, 0, fmt.Errorf("jpeg over budget")
		}
		cur = scaleBilinear(toRGBA(cur), nw, nh)
		var buf bytes.Buffer
		if err = jpeg.Encode(&buf, cur, &jpeg.Options{Quality: jpegQualityFloor}); err != nil {
			return nil, 0, 0, 0, err
		}
		last = buf.Bytes()
		lastQ = jpegQualityFloor
	}
	return last, cur.Bounds().Dx(), cur.Bounds().Dy(), lastQ, nil
}

func shrinkDims(w, h, num, den int) (int, int) {
	if den < 1 {
		den = 1
	}
	nw := w * num / den
	nh := h * num / den
	if nw < 1 {
		nw = 1
	}
	if nh < 1 {
		nh = 1
	}
	if nw >= w && w > 1 {
		nw = w - 1
	}
	if nh >= h && h > 1 {
		nh = h - 1
	}
	return nw, nh
}

func pixelDigest(img *image.RGBA) string {
	sum := sha256.Sum256(img.Pix)
	return hex.EncodeToString(sum[:16])
}

func NormalizeDesktop(src image.Image, displayID string, dpr float64, maxW, maxH int) (*image.RGBA, DesktopFrame, error) {
	rgba := toRGBA(src)
	sw, sh := rgba.Bounds().Dx(), rgba.Bounds().Dy()
	maxW = clampMax(maxW, viewportLongMin, viewportLongMax, viewportLongDefault)
	maxH = clampMax(maxH, viewportLongMin, viewportLongMax, viewportLongDefault)
	dw, dh := fitBox(sw, sh, maxW, maxH)
	view := scaleBilinear(rgba, dw, dh)
	jpegBytes, vw, vh, _, err := encodeJPEGBudget(view, jpegBudgetBytes)
	if err != nil {
		return nil, DesktopFrame{}, err
	}
	if vw != view.Bounds().Dx() || vh != view.Bounds().Dy() {
		view = scaleBilinear(rgba, vw, vh)
	}
	scaleX := float64(sw) / float64(vw)
	scaleY := float64(sh) / float64(vh)
	if dpr <= 0 {
		dpr = 1
	}
	fr := DesktopFrame{
		ViewportW: vw,
		ViewportH: vh,
		DisplayID: displayID,
		DisplayW:  sw,
		DisplayH:  sh,
		DPR:       dpr,
		ScaleX:    scaleX,
		ScaleY:    scaleY,
		Origin:    "top-left",
		MIME:      "image/jpeg",
		JPEG:      jpegBytes,
		Bytes:     len(jpegBytes),
		Digest:    pixelDigest(view),
	}
	if fr.DisplayID == "" {
		fr.DisplayID = "primary"
	}
	return view, fr, nil
}

func MapViewportToNative(fr DesktopFrame, x, y int) (int, int, error) {
	if fr.ViewportW < 1 || fr.ViewportH < 1 {
		return 0, 0, desktopError{code: "no_frame", msg: "fleet: screenshot first"}
	}
	if x < 0 || y < 0 || x >= fr.ViewportW || y >= fr.ViewportH {
		return 0, 0, desktopError{code: "bad_coordinates", msg: "fleet: coordinates out of image"}
	}
	nx := mapAxis(x, fr.ViewportW, fr.DisplayW)
	ny := mapAxis(y, fr.ViewportH, fr.DisplayH)
	return nx, ny, nil
}

func mapAxis(v, view, native int) int {
	if view <= 1 {
		if native <= 1 {
			return 0
		}
		return native / 2
	}
	n := (v*(native-1) + (view-1)/2) / (view - 1)
	if n < 0 {
		return 0
	}
	if n > native-1 {
		return native - 1
	}
	return n
}

func FrameBody(fr DesktopFrame, unchanged bool) map[string]any {
	body := map[string]any{
		"ok":             true,
		"status":         "ok",
		"code":           "",
		"error":          "",
		"unchanged":      unchanged,
		"frame_id":       fr.ID,
		"width":          fr.ViewportW,
		"height":         fr.ViewportH,
		"display_width":  fr.DisplayW,
		"display_height": fr.DisplayH,
		"scale_x":        fr.ScaleX,
		"scale_y":        fr.ScaleY,
		"display_id":     fr.DisplayID,
		"origin":         fr.Origin,
		"dpr":            fr.DPR,
		"mime":           fr.MIME,
		"bytes":          fr.Bytes,
		"digest":         fr.Digest,
		"encoding":       "base64",
		"frame": map[string]any{
			"id":       fr.ID,
			"viewport": map[string]any{"width": fr.ViewportW, "height": fr.ViewportH},
			"display": map[string]any{
				"id":     fr.DisplayID,
				"width":  fr.DisplayW,
				"height": fr.DisplayH,
				"dpr":    fr.DPR,
			},
			"transform": map[string]any{
				"scale_x": fr.ScaleX,
				"scale_y": fr.ScaleY,
				"origin":  fr.Origin,
			},
			"image": map[string]any{
				"mime":     fr.MIME,
				"encoding": "base64",
				"bytes":    fr.Bytes,
			},
			"digest": fr.Digest,
		},
	}
	return body
}
