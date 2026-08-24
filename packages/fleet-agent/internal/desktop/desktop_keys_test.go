package desktop

import (
	"image/color"
	"testing"
)

func TestSplitKeySpec(t *testing.T) {
	got := splitKeySpec("Ctrl+Enter")
	if len(got) != 2 || got[0] != "ctrl" || got[1] != "enter" {
		t.Fatalf("%v", got)
	}
}

func TestDarwinKeyCode(t *testing.T) {
	if _, ok := darwinKeyCode("f1"); !ok {
		t.Fatal("f1")
	}
	if _, ok := darwinKeyCode("1"); !ok {
		t.Fatal("digit")
	}
	if _, ok := darwinKeyCode("home"); !ok {
		t.Fatal("home")
	}
	if k, ok := darwinKeyCode("a"); !ok || k != 0 {
		t.Fatalf("a %d %v", k, ok)
	}
	if _, ok := darwinKeyCode("fnord"); ok {
		t.Fatal("unknown must miss")
	}
}

func TestFitCaptureToHID(t *testing.T) {
	hi := solid(3840, 2160, color.RGBA{R: 9, G: 18, B: 27, A: 255})
	got := FitCaptureToHID(hi, 1920, 1080)
	if got.Bounds().Dx() != 1920 || got.Bounds().Dy() != 1080 {
		t.Fatalf("hid fit %dx%d", got.Bounds().Dx(), got.Bounds().Dy())
	}
	same := FitCaptureToHID(solid(1920, 1080, color.RGBA{R: 1, A: 255}), 1920, 1080)
	if same.Bounds().Dx() != 1920 {
		t.Fatal("same-size should stay")
	}
}

func TestBlankFrameDetectsSolidBlack(t *testing.T) {
	if !BlankFrame(solid(64, 64, color.RGBA{A: 255})) {
		t.Fatal("black should be blank")
	}
	if BlankFrame(solid(64, 64, color.RGBA{R: 40, G: 80, B: 10, A: 255})) {
		t.Fatal("textured should not be blank")
	}
}
