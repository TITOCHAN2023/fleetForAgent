package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"
	"time"

	"github.com/TITOCHAN2023/fleetForAgent/internal/desktop"
)

const (
	pendingKindDesktopShot  = "desktop_shot"
	pendingKindDesktopInput = "desktop_input"
	desktopTypeMax          = 4 * 1024
	desktopWaitMaxMs        = 5000
)

func clampWaitMsDesktop(ms int) int {
	if ms < 0 {
		return 0
	}
	if ms > desktopWaitMaxMs {
		return desktopWaitMaxMs
	}
	return ms
}

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

func (a *Agent) desktopIO() desktop.Backend {
	if a.backend != nil {
		return a.backend
	}
	if a.osBackend == nil {
		a.osBackend = desktop.NewOSBackend()
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

func (a *Agent) sendDesktop(ctx context.Context, sink EnvelopeSink, corr string, body map[string]any) {
	_ = sink(ctx, Envelope{
		V: 1, Type: "desktop", ID: fmt.Sprintf("%d", time.Now().UnixNano()),
		Corr: corr, T: time.Now().UnixMilli(), Body: body,
	})
}

func (a *Agent) handleDesktopScreenshot(ctx context.Context, sink EnvelopeSink, env Envelope) {
	a.sendDesktop(ctx, sink, env.Corr, a.desktopScreenshotBody(env.Corr, env.Body))
}

func (a *Agent) handleDesktopAction(ctx context.Context, sink EnvelopeSink, env Envelope) {
	a.sendDesktop(ctx, sink, env.Corr, a.desktopActionBody(env.Body))
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
		return desktop.Fail(code, msg)
	case permitAsk:
		a.desktopPending = &Pending{
			Corr: corr, Kind: pendingKindDesktopShot, Command: "desktop screenshot (primary display)",
			Requested: time.Now().UnixMilli(),
		}
		a.mu.Unlock()
		notifyConsent("desktop screenshot (primary display)")
		a.pushUI()
		return desktop.Consent()
	}
	if rateLimited(&a.shotTimes, time.Now(), 2, time.Second) {
		a.mu.Unlock()
		return desktop.Fail("rate_limited", "fleet: screenshot rate limited")
	}
	be := a.desktopIO()
	maxW := desktop.AsInt(body["max_width"])
	maxH := desktop.AsInt(body["max_height"])
	a.mu.Unlock()

	img, info, err := be.Capture()
	if err != nil {
		return desktop.MapErr(err)
	}
	if img == nil {
		return desktop.Fail("capture_failed", "fleet: empty capture")
	}
	if desktop.BlankFrame(img) {
		return desktop.Fail("capture_failed", "fleet: blank capture (fullscreen or protected window)")
	}
	_, fr, err := desktop.NormalizeDesktop(img, info.ID, info.Scale, maxW, maxH)
	if err != nil {
		return desktop.Fail("capture_failed", "fleet: "+err.Error())
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
	out := desktop.FrameBody(fr, unchanged)
	if !unchanged {
		out["image_b64"] = base64.StdEncoding.EncodeToString(fr.JPEG)
	}
	a.mu.Unlock()
	return out
}

func (a *Agent) desktopActionBody(body map[string]any) map[string]any {
	action := strings.ToLower(strings.TrimSpace(desktop.AsString(body["action"])))
	if action == "" {
		return desktop.Fail("bad_request", "fleet: action required")
	}
	if action == "screenshot" {
		return desktop.Fail("unsupported_action", "fleet: screenshot goes through desktop_screenshot")
	}
	if action == "wait" {
		ms := clampWaitMsDesktop(desktop.AsInt(body["duration_ms"]))
		if ms > 0 {
			time.Sleep(time.Duration(ms) * time.Millisecond)
		}
		return map[string]any{"ok": true, "status": "ok", "code": "", "error": ""}
	}

	needFrame := action == "left_click" || action == "right_click" || action == "double_click" ||
		action == "middle_click" || action == "mouse_move" || action == "left_click_drag" || action == "scroll"
	needInput := needFrame || action == "type" || action == "key"
	if !needInput {
		return desktop.Fail("unsupported_action", "fleet: unsupported action "+action)
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
		return desktop.Fail(code, msg)
	case permitAsk:
		a.desktopPending = &Pending{
			Corr: "", Kind: pendingKindDesktopInput, Command: "desktop mouse/keyboard",
			Requested: time.Now().UnixMilli(),
		}
		a.mu.Unlock()
		notifyConsent("desktop mouse/keyboard")
		a.pushUI()
		return desktop.Consent()
	}
	if rateLimited(&a.actTimes, time.Now(), 20, time.Second) {
		a.mu.Unlock()
		return desktop.Fail("rate_limited", "fleet: action rate limited")
	}
	frame := a.lastFrame
	be := a.desktopIO()
	a.mu.Unlock()

	if needFrame {
		if frame == nil {
			return desktop.Fail("no_frame", "fleet: screenshot first")
		}
		if fid := desktop.AsString(body["frame_id"]); fid != "" && fid != frame.ID {
			return desktop.Fail("stale_frame", "fleet: stale frame_id")
		}
	}

	err := a.runDesktopAction(be, frame, action, body)
	if err != nil {
		return desktop.MapErr(err)
	}
	a.mu.Lock()
	a.log("info", "desktop action "+action)
	a.mu.Unlock()
	return map[string]any{"ok": true, "status": "ok", "code": "", "error": ""}
}

func (a *Agent) runDesktopAction(be desktop.Backend, frame *desktop.DesktopFrame, action string, body map[string]any) error {
	mapXY := func(xKey, yKey string) (int, int, error) {
		x, err := desktop.RequiredInt(body, xKey)
		if err != nil {
			return 0, 0, err
		}
		y, err := desktop.RequiredInt(body, yKey)
		if err != nil {
			return 0, 0, err
		}
		return desktop.MapViewportToNative(*frame, x, y)
	}
	switch action {
	case "left_click":
		x, y, err := mapXY("x", "y")
		if err != nil {
			return err
		}
		return be.Click(desktop.ButtonLeft, 1, x, y)
	case "right_click":
		x, y, err := mapXY("x", "y")
		if err != nil {
			return err
		}
		return be.Click(desktop.ButtonRight, 1, x, y)
	case "middle_click":
		x, y, err := mapXY("x", "y")
		if err != nil {
			return err
		}
		return be.Click(desktop.ButtonMiddle, 1, x, y)
	case "double_click":
		x, y, err := mapXY("x", "y")
		if err != nil {
			return err
		}
		return be.Click(desktop.ButtonLeft, 2, x, y)
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
		return be.Scroll(x, y, desktop.AsInt(body["scroll_x"]), desktop.AsInt(body["scroll_y"]))
	case "type":
		text := desktop.AsString(body["text"])
		if text == "" {
			return desktop.Err("bad_request", "fleet: text required")
		}
		if len(text) > desktopTypeMax {
			return desktop.Err("bad_request", "fleet: text longer than 4KiB")
		}
		return be.TypeText(text)
	case "key":
		spec := strings.TrimSpace(desktop.AsString(body["key"]))
		if spec == "" {
			if keys, ok := body["keys"].([]any); ok {
				parts := make([]string, 0, len(keys))
				for _, k := range keys {
					parts = append(parts, desktop.AsString(k))
				}
				spec = strings.Join(parts, "+")
			} else {
				spec = desktop.AsString(body["keys"])
			}
		}
		if spec == "" {
			return desktop.Err("bad_request", "fleet: key required")
		}
		return be.Key(spec)
	default:
		return desktop.Err("unsupported_action", "fleet: unsupported action "+action)
	}
}
