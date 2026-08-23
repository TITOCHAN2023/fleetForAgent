package main

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/jpeg"
	"strings"
	"testing"
)

type fakeDesk struct {
	img        *image.RGBA
	info       DisplayInfo
	captureErr error
	shots      int
	clicks     [][]int
	moves      [][]int
	drags      [][]int
	scrolls    [][]int
	typed      []string
	keys       []string
}

func (f *fakeDesk) Capture() (*image.RGBA, DisplayInfo, error) {
	f.shots++
	if f.captureErr != nil {
		return nil, DisplayInfo{}, f.captureErr
	}
	if f.img == nil {
		f.img = solid(640, 360, color.RGBA{R: 40, G: 80, B: 120, A: 255})
		f.info = DisplayInfo{ID: "primary", Width: 640, Height: 360, Scale: 1}
	}
	return f.img, f.info, nil
}
func (f *fakeDesk) Click(button pointerButton, count, x, y int) error {
	f.clicks = append(f.clicks, []int{int(button), count, x, y})
	return nil
}
func (f *fakeDesk) Move(x, y int) error {
	f.moves = append(f.moves, []int{x, y})
	return nil
}
func (f *fakeDesk) Drag(x, y, x2, y2 int) error {
	f.drags = append(f.drags, []int{x, y, x2, y2})
	return nil
}
func (f *fakeDesk) Scroll(x, y, dx, dy int) error {
	f.scrolls = append(f.scrolls, []int{x, y, dx, dy})
	return nil
}
func (f *fakeDesk) TypeText(text string) error { f.typed = append(f.typed, text); return nil }
func (f *fakeDesk) Key(spec string) error      { f.keys = append(f.keys, spec); return nil }

func TestDesktopPermitOffDoesNotCapture(t *testing.T) {
	f := &fakeDesk{}
	a := &Agent{enabled: true, permit: PermitOff, backend: f}
	body := a.desktopScreenshotBody("c1", nil)
	if body["ok"] != false || body["code"] != "permit_off" {
		t.Fatalf("%+v", body)
	}
	if f.shots != 0 {
		t.Fatal("captured while permit=off")
	}
	if _, ok := body["image_b64"]; ok {
		t.Fatal("image on error")
	}
}

func TestDesktopAskConsentHasNoImage(t *testing.T) {
	f := &fakeDesk{}
	a := &Agent{enabled: true, permit: PermitAsk, backend: f}
	body := a.desktopScreenshotBody("c1", nil)
	if body["ok"] != false || body["code"] != "consent" || body["status"] != "consent" {
		t.Fatalf("%+v", body)
	}
	if f.shots != 0 {
		t.Fatal("captured before consent")
	}
	if _, ok := body["image_b64"]; ok {
		t.Fatal("image on consent")
	}
	if a.desktopPending == nil || a.desktopPending.Kind != pendingKindDesktopShot {
		t.Fatal("expected shot pending")
	}
	a.approve()
	if !a.desktopShotGranted || a.desktopPending != nil {
		t.Fatal("approve should grant shot")
	}
	body = a.desktopScreenshotBody("c2", map[string]any{"max_width": 1280, "max_height": 1280})
	if body["ok"] != true {
		t.Fatalf("after grant %+v", body)
	}
	if f.shots != 1 {
		t.Fatalf("shots %d", f.shots)
	}
}

func TestDesktopAllowScreenshotBudgetAndMapping(t *testing.T) {
	src := solid(3840, 2160, color.RGBA{R: 30, G: 90, B: 150, A: 255})
	f := &fakeDesk{img: src, info: DisplayInfo{ID: "primary", Width: 3840, Height: 2160, Scale: 1}}
	a := &Agent{enabled: true, permit: PermitAllow, backend: f}
	body := a.desktopScreenshotBody("shot-1", map[string]any{"max_width": 1280, "max_height": 1280})
	if body["ok"] != true {
		t.Fatalf("%+v", body)
	}
	if body["width"].(int) != 1280 || body["height"].(int) != 720 {
		t.Fatalf("viewport %v %v", body["width"], body["height"])
	}
	b64, _ := body["image_b64"].(string)
	if b64 == "" {
		t.Fatal("missing jpeg")
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) > jpegBudgetBytes {
		t.Fatalf("jpeg %d", len(raw))
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Width != body["width"].(int) || cfg.Height != body["height"].(int) {
		t.Fatalf("jpeg %dx%d vs viewport", cfg.Width, cfg.Height)
	}
	click := a.desktopActionBody(map[string]any{"action": "left_click", "x": 1279, "y": 719})
	if click["ok"] != true {
		t.Fatalf("click %+v", click)
	}
	if len(f.clicks) != 1 || f.clicks[0][2] < 3830 {
		t.Fatalf("mapped click %+v", f.clicks)
	}
}

func TestDesktopClickRequiresFrame(t *testing.T) {
	a := &Agent{enabled: true, permit: PermitAllow, backend: &fakeDesk{}}
	body := a.desktopActionBody(map[string]any{"action": "left_click", "x": 1, "y": 1})
	if body["code"] != "no_frame" {
		t.Fatalf("%+v", body)
	}
}

func TestDesktopWaitClampsWithoutFrame(t *testing.T) {
	if clampWaitMsDesktop(-3) != 0 || clampWaitMsDesktop(9000) != 5000 || clampWaitMsDesktop(12) != 12 {
		t.Fatal("clamp")
	}
	a := &Agent{enabled: true, permit: PermitOff, backend: &fakeDesk{}}
	body := a.desktopActionBody(map[string]any{"action": "wait", "duration_ms": 0})
	if body["ok"] != true {
		t.Fatalf("wait should not need permit/frame %+v", body)
	}
}

func TestDesktopAskInputSeparateFromShot(t *testing.T) {
	f := &fakeDesk{}
	a := &Agent{enabled: true, permit: PermitAsk, backend: f, desktopShotGranted: true, lastFrame: &DesktopFrame{ID: "f", ViewportW: 10, ViewportH: 10, DisplayW: 10, DisplayH: 10}}
	body := a.desktopActionBody(map[string]any{"action": "left_click", "x": 1, "y": 1})
	if body["code"] != "consent" {
		t.Fatalf("shot grant must not imply input %+v", body)
	}
	if f.clicks != nil {
		t.Fatal("clicked without input grant")
	}
}

func TestDesktopDenyThenDenied(t *testing.T) {
	a := &Agent{enabled: true, permit: PermitAsk, backend: &fakeDesk{}}
	_ = a.desktopScreenshotBody("c", nil)
	a.deny()
	body := a.desktopScreenshotBody("c2", nil)
	if body["code"] != "denied" {
		t.Fatalf("%+v", body)
	}
	body = a.desktopScreenshotBody("c3", nil)
	if body["code"] != "consent" {
		t.Fatalf("after denied once, back to consent %+v", body)
	}
}

func TestDesktopBusy(t *testing.T) {
	a := &Agent{enabled: true, permit: PermitAsk, backend: &fakeDesk{}}
	_ = a.desktopScreenshotBody("c1", nil)
	body := a.desktopScreenshotBody("c2", nil)
	if body["code"] != "busy" {
		t.Fatalf("%+v", body)
	}
}

func TestDesktopLogsOmitImage(t *testing.T) {
	f := &fakeDesk{img: solid(800, 600, color.RGBA{R: 10, G: 20, B: 30, A: 255}), info: DisplayInfo{ID: "primary", Width: 800, Height: 600, Scale: 1}}
	a := &Agent{enabled: true, permit: PermitAllow, backend: f}
	_ = a.desktopScreenshotBody("c", nil)
	for _, l := range a.logs {
		if strings.Contains(l.Msg, "image_b64") || strings.Contains(l.Msg, "/9j/") {
			t.Fatalf("log leaked image: %s", l.Msg)
		}
	}
}

func TestDesktopDragAndTypeAndKey(t *testing.T) {
	f := &fakeDesk{}
	fr := &DesktopFrame{ID: "f", ViewportW: 100, ViewportH: 100, DisplayW: 200, DisplayH: 200}
	a := &Agent{enabled: true, permit: PermitAllow, backend: f, lastFrame: fr}
	if body := a.desktopActionBody(map[string]any{"action": "left_click_drag", "x": 0, "y": 0, "x2": 99, "y2": 99}); body["ok"] != true {
		t.Fatalf("drag %+v", body)
	}
	if len(f.drags) != 1 {
		t.Fatalf("drags %+v", f.drags)
	}
	if body := a.desktopActionBody(map[string]any{"action": "type", "text": "hi"}); body["ok"] != true {
		t.Fatalf("type %+v", body)
	}
	if body := a.desktopActionBody(map[string]any{"action": "key", "key": "ctrl+c"}); body["ok"] != true {
		t.Fatalf("key %+v", body)
	}
	if len(f.typed) != 1 || f.keys[0] != "ctrl+c" {
		t.Fatalf("typed=%v keys=%v", f.typed, f.keys)
	}
}

func TestSplitKeySpec(t *testing.T) {
	got := splitKeySpec("Ctrl+Enter")
	if len(got) != 2 || got[0] != "ctrl" || got[1] != "enter" {
		t.Fatalf("%v", got)
	}
}

func TestBlankFrameDetectsSolidBlack(t *testing.T) {
	if !blankFrame(solid(64, 64, color.RGBA{A: 255})) {
		t.Fatal("black should be blank")
	}
	if blankFrame(solid(64, 64, color.RGBA{R: 40, G: 80, B: 10, A: 255})) {
		t.Fatal("textured should not be blank")
	}
}

func TestAskGrantsDieWithSocketClose(t *testing.T) {
	f := &fakeDesk{}
	a := &Agent{enabled: true, permit: PermitAsk, backend: f, desktopShotGranted: true, desktopInputGranted: true, lastFrame: &DesktopFrame{ID: "f", ViewportW: 10, ViewportH: 10, DisplayW: 10, DisplayH: 10}}
	a.clearDesktopSessionLocked()
	body := a.desktopScreenshotBody("n", nil)
	if body["code"] != "consent" {
		t.Fatalf("shot after WS drop %+v", body)
	}
	a.desktopPending = nil
	body = a.desktopActionBody(map[string]any{"action": "left_click", "x": 1, "y": 1})
	if body["code"] != "consent" && body["code"] != "no_frame" {
		t.Fatalf("input after WS drop %+v", body)
	}
}

func TestAgentCapsAdvertiseComputerUse(t *testing.T) {
	caps := agentCaps()
	if desktopSupported() && !containsStr(caps, "computer_use") {
		t.Fatalf("%v", caps)
	}
}

func containsStr(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}
