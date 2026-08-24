package desktop

import (
	"fmt"
	"image"
	"strings"
)

type DisplayInfo struct {
	ID            string
	Width, Height int
	Scale         float64
}

type PointerButton = pointerButton

type Backend interface {
	Capture() (*image.RGBA, DisplayInfo, error)
	Click(button PointerButton, count, x, y int) error
	Move(x, y int) error
	Drag(x, y, x2, y2 int) error
	Scroll(x, y, dx, dy int) error
	TypeText(text string) error
	Key(spec string) error
}

func Supported() bool { return desktopSupported() }

type desktopError struct {
	code       string
	msg        string
	permission string
}

func (e desktopError) Error() string { return e.msg }

func Fail(code, msg string) map[string]any {
	return map[string]any{
		"ok": false, "status": "error", "code": code, "error": msg,
	}
}

func Consent() map[string]any {
	return map[string]any{
		"ok":     false,
		"status": "consent",
		"code":   "consent",
		"error":  "fleet: waiting for consent at the machine",
	}
}

func Err(code, msg string) error {
	return desktopError{code: code, msg: msg}
}

func AsInt(v any) int {
	n, ok := IntFrom(v)
	if !ok {
		return 0
	}
	return n
}

func IntFrom(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case int32:
		return int(n), true
	case int64:
		return int(n), true
	case float64:
		return int(n), true
	case float32:
		return int(n), true
	case string:
		var x int
		if _, err := fmt.Sscanf(strings.TrimSpace(n), "%d", &x); err != nil || strings.TrimSpace(n) == "" {
			return 0, false
		}
		return x, true
	default:
		return 0, false
	}
}

func RequiredInt(body map[string]any, key string) (int, error) {
	if body == nil {
		return 0, desktopError{code: "bad_request", msg: "fleet: " + key + " required"}
	}
	v, ok := body[key]
	if !ok || v == nil {
		return 0, desktopError{code: "bad_request", msg: "fleet: " + key + " required"}
	}
	n, ok := IntFrom(v)
	if !ok {
		return 0, desktopError{code: "bad_request", msg: "fleet: " + key + " required"}
	}
	return n, nil
}

func AsString(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}

func MapErr(err error) map[string]any {
	if err == nil {
		return map[string]any{"ok": true, "status": "ok", "code": "", "error": ""}
	}
	code := "capture_failed"
	msg := err.Error()
	perm := ""
	if de, ok := err.(desktopError); ok {
		code = de.code
		msg = de.msg
		perm = de.permission
	} else {
		s := err.Error()
		switch {
		case s == "no_frame" || strings.Contains(s, "no_frame"):
			code = "no_frame"
		case s == "bad_coordinates" || strings.Contains(s, "bad_coordinates"):
			code = "bad_coordinates"
		case strings.Contains(s, "no_input_backend"):
			code = "no_input_backend"
		}
	}
	out := Fail(code, msg)
	if perm != "" {
		out["permission"] = perm
	}
	return out
}

const (
	ButtonLeft   = pointerLeft
	ButtonRight  = pointerRight
	ButtonMiddle = pointerMiddle
)

type osBackend struct{}

func (osBackend) Capture() (*image.RGBA, DisplayInfo, error) { return nativeCapture() }
func (osBackend) Click(button PointerButton, count, x, y int) error {
	return pointerClickAt(x, y, button, count)
}
func (osBackend) Move(x, y int) error { return pointerMoveAt(x, y) }
func (osBackend) Drag(x, y, x2, y2 int) error {
	return pointerDragAt(x, y, x2, y2)
}
func (osBackend) Scroll(x, y, dx, dy int) error { return nativeScroll(x, y, dx, dy) }
func (osBackend) TypeText(text string) error    { return nativeTypeText(text) }
func (osBackend) Key(spec string) error         { return nativeKey(spec) }

func NewOSBackend() Backend { return osBackend{} }

func BlankFrame(img *image.RGBA) bool {
	w, h := img.Bounds().Dx(), img.Bounds().Dy()
	if w < 1 || h < 1 {
		return true
	}
	step := 8
	if w < 32 || h < 32 {
		step = 1
	}
	var n, sum, sumsq uint64
	for y := 0; y < h; y += step {
		for x := 0; x < w; x += step {
			c := img.RGBAAt(x, y)
			v := uint64(c.R) + uint64(c.G) + uint64(c.B)
			sum += v
			sumsq += v * v
			n++
		}
	}
	if n == 0 {
		return true
	}
	mean := float64(sum) / float64(n)
	varm := float64(sumsq)/float64(n) - mean*mean
	return mean < 4 && varm < 2
}

func FitCaptureToHID(img *image.RGBA, hidW, hidH int) *image.RGBA {
	if img == nil || hidW < 2 || hidH < 2 {
		return img
	}
	w, h := img.Bounds().Dx(), img.Bounds().Dy()
	if w <= hidW+2 && h <= hidH+2 {
		return img
	}
	return scaleBilinear(img, hidW, hidH)
}
