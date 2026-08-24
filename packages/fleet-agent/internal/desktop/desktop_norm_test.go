package desktop

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
)

func solid(w, h int, c color.RGBA) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetRGBA(x, y, c)
		}
	}
	return img
}

func TestFitBoxNeverUpscales(t *testing.T) {
	w, h := fitBox(800, 600, 1280, 1280)
	if w != 800 || h != 600 {
		t.Fatalf("got %dx%d want 800x600", w, h)
	}
}

func TestFitBoxShrinks4KToViewport(t *testing.T) {
	w, h := fitBox(3840, 2160, 1280, 1280)
	if w != 1280 || h != 720 {
		t.Fatalf("4K → viewport got %dx%d want 1280x720", w, h)
	}
}

func TestFitBoxClampsRequest(t *testing.T) {
	w, h := fitBox(3840, 2160, 8000, 8000)
	if w > viewportLongMax || h > viewportLongMax {
		t.Fatalf("must clamp long edge, got %dx%d", w, h)
	}
}

func TestNormalize4KStaysUnderBudget(t *testing.T) {
	src := solid(3840, 2160, color.RGBA{R: 40, G: 80, B: 160, A: 255})
	_, fr, err := NormalizeDesktop(src, "primary", 1, 1280, 1280)
	if err != nil {
		t.Fatal(err)
	}
	if fr.ViewportW != 1280 || fr.ViewportH != 720 {
		t.Fatalf("viewport %dx%d", fr.ViewportW, fr.ViewportH)
	}
	if fr.DisplayW != 3840 || fr.DisplayH != 2160 {
		t.Fatalf("display %dx%d", fr.DisplayW, fr.DisplayH)
	}
	if fr.Bytes > jpegBudgetBytes {
		t.Fatalf("compressed %d > budget %d", fr.Bytes, jpegBudgetBytes)
	}
	if fr.Bytes < 100 {
		t.Fatalf("suspiciously small jpeg %d", fr.Bytes)
	}
	if fr.MIME != "image/jpeg" || fr.Origin != "top-left" {
		t.Fatalf("meta %+v", fr)
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(fr.JPEG))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Width != fr.ViewportW || cfg.Height != fr.ViewportH {
		t.Fatalf("jpeg %dx%d vs viewport %dx%d — clicks would miss", cfg.Width, cfg.Height, fr.ViewportW, fr.ViewportH)
	}
	nx, ny, err := MapViewportToNative(fr, fr.ViewportW-1, fr.ViewportH-1)
	if err != nil {
		t.Fatal(err)
	}
	if nx < 3836 || nx > 3839 || ny < 2156 || ny > 2159 {
		t.Fatalf("corner map (%d,%d) want near (3839,2159)", nx, ny)
	}
	cx, cy, err := MapViewportToNative(fr, 640, 360)
	if err != nil {
		t.Fatal(err)
	}
	if cx < 1900 || cx > 1940 || cy < 1060 || cy > 1100 {
		t.Fatalf("center map (%d,%d) want ~ (1920,1080)", cx, cy)
	}
}

func TestMapRejectsOutOfViewport(t *testing.T) {
	fr := DesktopFrame{ViewportW: 100, ViewportH: 50, DisplayW: 200, DisplayH: 100, ScaleX: 2, ScaleY: 2}
	if _, _, err := MapViewportToNative(fr, 100, 0); err == nil {
		t.Fatal("want bad_coordinates")
	}
	if _, _, err := MapViewportToNative(DesktopFrame{}, 0, 0); err == nil {
		t.Fatal("want no_frame")
	}
}

func TestSamePixelsSameDigest(t *testing.T) {
	a := solid(640, 360, color.RGBA{R: 10, G: 20, B: 30, A: 255})
	b := solid(640, 360, color.RGBA{R: 10, G: 20, B: 30, A: 255})
	_, fa, err := NormalizeDesktop(a, "primary", 1, 1280, 1280)
	if err != nil {
		t.Fatal(err)
	}
	_, fb, err := NormalizeDesktop(b, "primary", 1, 1280, 1280)
	if err != nil {
		t.Fatal(err)
	}
	if fa.Digest == "" || fa.Digest != fb.Digest {
		t.Fatalf("digest %q vs %q", fa.Digest, fb.Digest)
	}
}

func TestEncodeJPEGBudgetNeverExceeds(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 640, 640))
	for y := 0; y < 640; y++ {
		for x := 0; x < 640; x++ {
			src.SetRGBA(x, y, color.RGBA{R: uint8(x * y), G: uint8(x ^ y), B: uint8(x + y), A: 255})
		}
	}
	data, w, h, _, err := encodeJPEGBudget(src, 8*1024)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) > 8*1024 {
		t.Fatalf("jpeg %d over hard budget", len(data))
	}
	if w < 1 || h < 1 {
		t.Fatalf("empty %dx%d", w, h)
	}
}

func TestBusyDesktopJPEGUnderBudget(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 2560, 1440))
	for y := 0; y < 1440; y++ {
		for x := 0; x < 2560; x++ {
			src.SetRGBA(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: uint8(x ^ y), A: 255})
		}
	}
	_, fr, err := NormalizeDesktop(src, "primary", 1, 1280, 1280)
	if err != nil {
		t.Fatal(err)
	}
	if fr.Bytes > jpegBudgetBytes {
		t.Fatalf("busy desktop %d bytes > %d", fr.Bytes, jpegBudgetBytes)
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(fr.JPEG))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Width != fr.ViewportW || cfg.Height != fr.ViewportH {
		t.Fatalf("jpeg %dx%d vs viewport %dx%d", cfg.Width, cfg.Height, fr.ViewportW, fr.ViewportH)
	}
	if _, _, err := MapViewportToNative(fr, fr.ViewportW-1, fr.ViewportH-1); err != nil {
		t.Fatal(err)
	}
}

func TestFrameBodyHasCUAAliasesAndNestedFrame(t *testing.T) {
	fr := DesktopFrame{
		ID: "f1", ViewportW: 1280, ViewportH: 720,
		DisplayID: "primary", DisplayW: 3840, DisplayH: 2160, DPR: 1,
		ScaleX: 3, ScaleY: 3, Origin: "top-left",
		MIME: "image/jpeg", Bytes: 12, Digest: "ab",
	}
	body := FrameBody(fr, false)
	if body["width"] != 1280 || body["display_width"] != 3840 {
		t.Fatalf("CUA aliases %+v", body)
	}
	frame, _ := body["frame"].(map[string]any)
	vp, _ := frame["viewport"].(map[string]any)
	if vp["width"] != 1280 {
		t.Fatalf("nested viewport %+v", frame)
	}
	if body["unchanged"] != false {
		t.Fatal("unchanged")
	}
}
