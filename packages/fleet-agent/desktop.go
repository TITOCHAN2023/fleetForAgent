package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"image"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const (
	pendingKindDesktopShot  = "desktop_shot"
	pendingKindDesktopInput = "desktop_input"
	desktopTypeMax          = 4 * 1024
	desktopWaitMaxMs        = 5000
)

func pruneTimes(ts []time.Time, now time.Time, window time.Duration) []time.Time {
	cut := now.Add(-window)
	n := 0
	for _, t := range ts {
		if !t.Before(cut) {
			ts[n] = t
			n++
		}
	}
	return ts[:n]
}

func rateLimited(ts *[]time.Time, now time.Time, max int, window time.Duration) bool {
	*ts = pruneTimes(*ts, now, window)
	if len(*ts) >= max {
		return true
	}
	*ts = append(*ts, now)
	return false
}

type desktopKind int

const (
	desktopKindShot desktopKind = iota
	desktopKindInput
)

type DisplayInfo struct {
	ID            string
	Width, Height int
	Scale         float64
}

type desktopBackend interface {
	Capture() (*image.RGBA, DisplayInfo, error)
	Click(button pointerButton, count, x, y int) error
	Move(x, y int) error
	Drag(x, y, x2, y2 int) error
	Scroll(x, y, dx, dy int) error
	TypeText(text string) error
	Key(spec string) error
}

type desktopError struct {
	code       string
	msg        string
	permission string
}

func (e desktopError) Error() string { return e.msg }

func desktopFail(code, msg string) map[string]any {
	return map[string]any{
		"ok": false, "status": "error", "code": code, "error": msg,
	}
}

func desktopConsent() map[string]any {
	return map[string]any{
		"ok":     false,
		"status": "consent",
		"code":   "consent",
		"error":  "fleet: waiting for consent at the machine",
	}
}

func asInt(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int32:
		return int(n)
	case int64:
		return int(n)
	case float64:
		return int(n)
	case float32:
		return int(n)
	case string:
		var x int
		_, _ = fmt.Sscanf(n, "%d", &x)
		return x
	default:
		return 0
	}
}

func asString(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}

func (a *Agent) desktopIO() desktopBackend {
	if a.backend != nil {
		return a.backend
	}
	if a.osBackend == nil {
		a.osBackend = newOSBackend()
	}
	return a.osBackend
}

func (a *Agent) desktopVerdict(kind desktopKind) (permitVerdict, string) {
	if !a.enabled || a.permit == PermitOff {
		return permitRefuse, "fleet: permit=off — 本机不允许桌面控制"
	}
	if a.permit == PermitAllow {
		return permitProceed, ""
	}
	if a.desktopDeniedOnce {
		a.desktopDeniedOnce = false
		return permitRefuse, "fleet: denied at the machine"
	}
	granted := a.desktopShotGranted
	if kind == desktopKindInput {
		granted = a.desktopInputGranted
	}
	if granted {
		return permitProceed, ""
	}
	if a.desktopPending != nil {
		return permitRefuse, "fleet: another desktop request is waiting for consent"
	}
	return permitAsk, ""
}

func (a *Agent) sendDesktop(ctx context.Context, c *websocket.Conn, corr string, body map[string]any) {
	_ = wsjson.Write(ctx, c, Envelope{
		V: 1, Type: "desktop", ID: fmt.Sprintf("%d", time.Now().UnixNano()),
		Corr: corr, T: time.Now().UnixMilli(), Body: body,
	})
}

func (a *Agent) handleDesktopScreenshot(ctx context.Context, c *websocket.Conn, env Envelope) {
	a.sendDesktop(ctx, c, env.Corr, a.desktopScreenshotBody(env.Corr, env.Body))
}

func (a *Agent) handleDesktopAction(ctx context.Context, c *websocket.Conn, env Envelope) {
	a.sendDesktop(ctx, c, env.Corr, a.desktopActionBody(env.Body))
}

func (a *Agent) desktopScreenshotBody(corr string, body map[string]any) map[string]any {
	a.mu.Lock()
	v, msg := a.desktopVerdict(desktopKindShot)
	switch v {
	case permitRefuse:
		code := "permit_off"
		if strings.Contains(msg, "denied") {
			code = "denied"
		} else if strings.Contains(msg, "waiting") {
			code = "busy"
		}
		a.mu.Unlock()
		return desktopFail(code, msg)
	case permitAsk:
		a.desktopPending = &Pending{
			Corr: corr, Kind: pendingKindDesktopShot, Command: "desktop screenshot (primary display)",
			Requested: time.Now().UnixMilli(),
		}
		a.mu.Unlock()
		notifyConsent("desktop screenshot (primary display)")
		a.pushUI()
		return desktopConsent()
	}
	if rateLimited(&a.shotTimes, time.Now(), 2, time.Second) {
		a.mu.Unlock()
		return desktopFail("rate_limited", "fleet: screenshot rate limited")
	}
	be := a.desktopIO()
	maxW := asInt(body["max_width"])
	maxH := asInt(body["max_height"])
	a.mu.Unlock()

	img, info, err := be.Capture()
	if err != nil {
		return mapDesktopErr(err)
	}
	if img == nil {
		return desktopFail("capture_failed", "fleet: empty capture")
	}
	if blankFrame(img) {
		return desktopFail("capture_failed", "fleet: blank capture (fullscreen or protected window)")
	}
	_, fr, err := normalizeDesktop(img, info.ID, info.Scale, maxW, maxH)
	if err != nil {
		return desktopFail("capture_failed", "fleet: "+err.Error())
	}
	fr.ID = corr

	a.mu.Lock()
	unchanged := a.lastDigest != "" && a.lastDigest == fr.Digest && a.lastFrame != nil
	if unchanged {
		fr.ID = a.lastFrame.ID
	} else {
		cp := fr
		a.lastFrame = &cp
		a.lastDigest = fr.Digest
	}
	a.log("info", fmt.Sprintf("desktop screenshot %dx%d jpeg %dKB ok", fr.ViewportW, fr.ViewportH, fr.Bytes/1024))
	out := desktopFrameBody(fr, unchanged)
	if !unchanged {
		out["image_b64"] = base64.StdEncoding.EncodeToString(fr.JPEG)
	}
	a.mu.Unlock()
	return out
}

func (a *Agent) desktopActionBody(body map[string]any) map[string]any {
	action := strings.ToLower(strings.TrimSpace(asString(body["action"])))
	if action == "" {
		return desktopFail("bad_request", "fleet: action required")
	}
	if action == "screenshot" {
		return desktopFail("unsupported_action", "fleet: screenshot goes through desktop_screenshot")
	}
	if action == "wait" {
		ms := asInt(body["duration_ms"])
		if ms < 0 {
			ms = 0
		}
		if ms > desktopWaitMaxMs {
			ms = desktopWaitMaxMs
		}
		if ms > 0 {
			time.Sleep(time.Duration(ms) * time.Millisecond)
		}
		return map[string]any{"ok": true, "status": "ok", "code": "", "error": ""}
	}

	needFrame := action == "left_click" || action == "right_click" || action == "double_click" ||
		action == "middle_click" || action == "mouse_move" || action == "left_click_drag" || action == "scroll"
	needInput := needFrame || action == "type" || action == "key"
	if !needInput {
		return desktopFail("unsupported_action", "fleet: unsupported action "+action)
	}

	a.mu.Lock()
	v, msg := a.desktopVerdict(desktopKindInput)
	switch v {
	case permitRefuse:
		code := "permit_off"
		if strings.Contains(msg, "denied") {
			code = "denied"
		} else if strings.Contains(msg, "waiting") {
			code = "busy"
		}
		a.mu.Unlock()
		return desktopFail(code, msg)
	case permitAsk:
		a.desktopPending = &Pending{
			Corr: "", Kind: pendingKindDesktopInput, Command: "desktop mouse/keyboard",
			Requested: time.Now().UnixMilli(),
		}
		a.mu.Unlock()
		notifyConsent("desktop mouse/keyboard")
		a.pushUI()
		return desktopConsent()
	}
	if rateLimited(&a.actTimes, time.Now(), 20, time.Second) {
		a.mu.Unlock()
		return desktopFail("rate_limited", "fleet: action rate limited")
	}
	frame := a.lastFrame
	be := a.desktopIO()
	a.mu.Unlock()

	if needFrame {
		if frame == nil {
			return desktopFail("no_frame", "fleet: screenshot first")
		}
		if fid := asString(body["frame_id"]); fid != "" && fid != frame.ID {
			return desktopFail("stale_frame", "fleet: stale frame_id")
		}
	}

	err := a.runDesktopAction(be, frame, action, body)
	if err != nil {
		return mapDesktopErr(err)
	}
	a.mu.Lock()
	a.log("info", "desktop action "+action)
	a.mu.Unlock()
	return map[string]any{"ok": true, "status": "ok", "code": "", "error": ""}
}

func (a *Agent) runDesktopAction(be desktopBackend, frame *DesktopFrame, action string, body map[string]any) error {
	mapXY := func(xKey, yKey string) (int, int, error) {
		x, y := asInt(body[xKey]), asInt(body[yKey])
		nx, ny, err := mapViewportToNative(*frame, x, y)
		return nx, ny, err
	}
	switch action {
	case "left_click":
		x, y, err := mapXY("x", "y")
		if err != nil {
			return err
		}
		return be.Click(pointerLeft, 1, x, y)
	case "right_click":
		x, y, err := mapXY("x", "y")
		if err != nil {
			return err
		}
		return be.Click(pointerRight, 1, x, y)
	case "middle_click":
		x, y, err := mapXY("x", "y")
		if err != nil {
			return err
		}
		return be.Click(pointerMiddle, 1, x, y)
	case "double_click":
		x, y, err := mapXY("x", "y")
		if err != nil {
			return err
		}
		return be.Click(pointerLeft, 2, x, y)
	case "mouse_move":
		x, y, err := mapXY("x", "y")
		if err != nil {
			return err
		}
		return be.Move(x, y)
	case "left_click_drag":
		x, y, err := mapXY("x", "y")
		if err != nil {
			return err
		}
		x2, y2, err := mapXY("x2", "y2")
		if err != nil {
			return err
		}
		return be.Drag(x, y, x2, y2)
	case "scroll":
		x, y, err := mapXY("x", "y")
		if err != nil {
			return err
		}
		return be.Scroll(x, y, asInt(body["scroll_x"]), asInt(body["scroll_y"]))
	case "type":
		text := asString(body["text"])
		if text == "" {
			return desktopError{code: "bad_request", msg: "fleet: text required"}
		}
		if len(text) > desktopTypeMax {
			return desktopError{code: "bad_request", msg: "fleet: text longer than 4KiB"}
		}
		return be.TypeText(text)
	case "key":
		spec := strings.TrimSpace(asString(body["key"]))
		if spec == "" {
			if keys, ok := body["keys"].([]any); ok {
				parts := make([]string, 0, len(keys))
				for _, k := range keys {
					parts = append(parts, asString(k))
				}
				spec = strings.Join(parts, "+")
			} else {
				spec = asString(body["keys"])
			}
		}
		if spec == "" {
			return desktopError{code: "bad_request", msg: "fleet: key required"}
		}
		return be.Key(spec)
	default:
		return desktopError{code: "unsupported_action", msg: "fleet: unsupported action " + action}
	}
}

func mapDesktopErr(err error) map[string]any {
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
	out := desktopFail(code, msg)
	if perm != "" {
		out["permission"] = perm
	}
	return out
}

func blankFrame(img *image.RGBA) bool {
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

func clampWaitMsDesktop(ms int) int {
	if ms < 0 {
		return 0
	}
	if ms > desktopWaitMaxMs {
		return desktopWaitMaxMs
	}
	return ms
}

type osBackend struct{}

func (osBackend) Capture() (*image.RGBA, DisplayInfo, error) { return nativeCapture() }
func (osBackend) Click(button pointerButton, count, x, y int) error {
	return pointerClickAt(x, y, button, count)
}
func (osBackend) Move(x, y int) error { return pointerMoveAt(x, y) }
func (osBackend) Drag(x, y, x2, y2 int) error {
	return pointerDragAt(x, y, x2, y2)
}
func (osBackend) Scroll(x, y, dx, dy int) error { return nativeScroll(x, y, dx, dy) }
func (osBackend) TypeText(text string) error    { return nativeTypeText(text) }
func (osBackend) Key(spec string) error         { return nativeKey(spec) }

func newOSBackend() desktopBackend { return osBackend{} }
