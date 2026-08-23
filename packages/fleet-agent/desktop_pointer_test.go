package main

import (
	"fmt"
	"image"
	"testing"
)

type fakePointer struct {
	moves         []vec2
	downs         []pointerButton
	ups           []pointerButton
	pos           vec2
	failWhileHeld bool
}

func (f *fakePointer) CursorPos() (float64, float64, error) { return f.pos.X, f.pos.Y, nil }
func (f *fakePointer) MoveAbs(x, y float64) error {
	f.pos = vec2{x, y}
	f.moves = append(f.moves, f.pos)
	if f.failWhileHeld && len(f.downs) > len(f.ups) {
		return fmt.Errorf("boom")
	}
	return nil
}
func (f *fakePointer) Button(button pointerButton, down bool) error {
	if down {
		f.downs = append(f.downs, button)
	} else {
		f.ups = append(f.ups, button)
	}
	return nil
}

type fakeOverlay struct{ frames int }

func (o *fakeOverlay) Show() error                 { return nil }
func (o *fakeOverlay) Paint(cursorFrame) error     { o.frames++; return nil }
func (o *fakeOverlay) Hide()                       {}

func TestClickScriptMovesBeforeButton(t *testing.T) {
	script := planClickScript(vec2{20, 400}, vec2{500, 80}, motionBounds{0, 0, 1280, 720}, pointerLeft, 1)
	firstMove, firstDown, firstUp := -1, -1, -1
	for i, ev := range script.Events {
		switch ev.Kind {
		case pointerMove:
			if firstMove < 0 {
				firstMove = i
			}
		case pointerDown:
			if firstDown < 0 {
				firstDown = i
			}
		case pointerUp:
			if firstUp < 0 {
				firstUp = i
			}
		}
	}
	if firstMove < 0 || firstDown < 0 || firstUp < 0 {
		t.Fatalf("missing events move=%d down=%d up=%d", firstMove, firstDown, firstUp)
	}
	if !(firstMove < firstDown && firstDown < firstUp) {
		t.Fatalf("order move=%d down=%d up=%d", firstMove, firstDown, firstUp)
	}
	if script.End.sub(vec2{500, 80}).length() > 2 {
		t.Fatalf("end %+v", script.End)
	}
}

func TestPlayClickNeverTeleports(t *testing.T) {
	old := pointerRest
	pointerRest = 0
	defer func() { pointerRest = old }()
	dev := &fakePointer{pos: vec2{30, 30}}
	ov := &fakeOverlay{}
	script := planClickScript(vec2{30, 30}, vec2{260, 200}, motionBounds{0, 0, 800, 600}, pointerLeft, 1)
	if err := playPointerOn(dev, ov, script); err != nil {
		t.Fatal(err)
	}
	if len(dev.moves) < 8 {
		t.Fatalf("expected a trail of HID moves, got %d", len(dev.moves))
	}
	if len(dev.downs) != 1 || len(dev.ups) != 1 {
		t.Fatalf("click count down=%d up=%d", len(dev.downs), len(dev.ups))
	}
	for i := 1; i < len(dev.moves); i++ {
		if dev.moves[i].sub(dev.moves[i-1]).length() >= 80 {
			t.Fatalf("HID teleport at %d", i)
		}
	}
	last := dev.moves[len(dev.moves)-1]
	if last.sub(vec2{260, 200}).length() > 2 {
		t.Fatalf("HID ended at %+v", last)
	}
	if ov.frames < len(dev.moves) {
		t.Fatalf("overlay frames %d < moves %d", ov.frames, len(dev.moves))
	}
}

func TestDragHoldsButtonAlongPath(t *testing.T) {
	script := planDragScript(vec2{10, 10}, vec2{40, 40}, vec2{200, 180}, motionBounds{0, 0, 400, 400})
	downAt, upAt := -1, -1
	movesWhileDown := 0
	down := false
	for i, ev := range script.Events {
		switch ev.Kind {
		case pointerDown:
			downAt = i
			down = true
		case pointerUp:
			upAt = i
			down = false
		case pointerMove:
			if down {
				movesWhileDown++
			}
		}
	}
	if downAt < 0 || upAt <= downAt {
		t.Fatalf("down=%d up=%d", downAt, upAt)
	}
	if movesWhileDown < 5 {
		t.Fatalf("drag must move while held, got %d", movesWhileDown)
	}
}

func TestPlayReleasesButtonOnMoveError(t *testing.T) {
	old := pointerRest
	pointerRest = 0
	defer func() { pointerRest = old }()
	dev := &fakePointer{pos: vec2{10, 10}, failWhileHeld: true}
	script := planDragScript(vec2{10, 10}, vec2{20, 20}, vec2{220, 180}, motionBounds{0, 0, 400, 400})
	err := playPointerOn(dev, &fakeOverlay{}, script)
	if err == nil {
		t.Fatal("expected move error")
	}
	if len(dev.downs) == 0 {
		t.Fatal("expected a down before failure")
	}
	if len(dev.ups) != len(dev.downs) {
		t.Fatalf("stuck button down=%d up=%d", len(dev.downs), len(dev.ups))
	}
}

func TestResolvePointerStartPrefersOSCursor(t *testing.T) {
	agentPointer = pointerState{have: true, pos: vec2{10, 10}}
	defer func() { agentPointer = pointerState{} }()
	dev := &fakePointer{pos: vec2{400, 300}}
	got := resolvePointerStart(dev)
	if got.sub(vec2{400, 300}).length() > 1 {
		t.Fatalf("start %+v, want OS cursor", got)
	}
}

func TestCursorGlyphCoversHotspot(t *testing.T) {
	img := drawCursorOverlay(cursorFrame{X: 100, Y: 100, Angle: 0.2})
	c := img.RGBAAt(cursorHotX, cursorHotY)
	if int(c.A) < 80 {
		t.Fatalf("hotspot too transparent: %+v", c)
	}
	empty := 0
	for _, v := range img.Pix {
		if v == 0 {
			empty++
		}
	}
	if empty == len(img.Pix) {
		t.Fatal("blank overlay")
	}
	bgra := premultiplyBGRA(img)
	if len(bgra) != cursorCanvas*cursorCanvas*4 {
		t.Fatalf("bgra len %d", len(bgra))
	}
}

func TestCursorRippleChangesPixels(t *testing.T) {
	idle := drawCursorOverlay(cursorFrame{})
	pulse := drawCursorOverlay(cursorFrame{Pulse: 1, Pressed: true})
	if idle.RGBAAt(cursorHotX+18, cursorHotY).A == pulse.RGBAAt(cursorHotX+18, cursorHotY).A {
		// ripple should light pixels away from the tip
		diff := 0
		for i := range idle.Pix {
			if idle.Pix[i] != pulse.Pix[i] {
				diff++
			}
		}
		if diff < 50 {
			t.Fatalf("click pulse too similar to idle, diff=%d", diff)
		}
	}
}

func TestPremultiplyZeroAlpha(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 1, 1))
	b := premultiplyBGRA(img)
	if b[0] != 0 || b[3] != 0 {
		t.Fatalf("%v", b)
	}
}
