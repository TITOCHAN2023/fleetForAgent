//go:build darwin

package desktop

/*
#cgo LDFLAGS: -framework ApplicationServices
#include <ApplicationServices/ApplicationServices.h>
#include <stdint.h>

static void fleetMouseMove(double x, double y, int dragged, int button) {
	CGPoint p = CGPointMake(x, y);
	CGEventType t = kCGEventMouseMoved;
	CGMouseButton b = kCGMouseButtonLeft;
	if (button == 1) b = kCGMouseButtonRight;
	else if (button == 2) b = kCGMouseButtonCenter;
	if (dragged) {
		if (button == 1) t = kCGEventRightMouseDragged;
		else if (button == 2) t = kCGEventOtherMouseDragged;
		else t = kCGEventLeftMouseDragged;
	}
	CGEventRef e = CGEventCreateMouseEvent(NULL, t, p, b);
	if (!e) return;
	CGEventPost(kCGHIDEventTap, e);
	CFRelease(e);
}

static void fleetMouseButton(double x, double y, int button, int down) {
	CGPoint p = CGPointMake(x, y);
	CGEventType t;
	CGMouseButton b = kCGMouseButtonLeft;
	if (button == 1) {
		b = kCGMouseButtonRight;
		t = down ? kCGEventRightMouseDown : kCGEventRightMouseUp;
	} else if (button == 2) {
		b = kCGMouseButtonCenter;
		t = down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp;
	} else {
		t = down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp;
	}
	CGEventRef e = CGEventCreateMouseEvent(NULL, t, p, b);
	if (!e) return;
	CGEventPost(kCGHIDEventTap, e);
	CFRelease(e);
}

static int fleetAXTrustedHID(void) {
	return AXIsProcessTrusted() ? 1 : 0;
}

static void fleetCursorPos(double *x, double *y) {
	CGEventRef e = CGEventCreate(NULL);
	if (!e) { *x = 0; *y = 0; return; }
	CGPoint p = CGEventGetLocation(e);
	CFRelease(e);
	*x = p.x;
	*y = p.y;
}

static void fleetDisplaySize(double *w, double *h) {
	CGDirectDisplayID id = CGMainDisplayID();
	*w = (double)CGDisplayPixelsWide(id);
	*h = (double)CGDisplayPixelsHigh(id);
}

static void fleetDisplayPoints(double *w, double *h) {
	CGRect b = CGDisplayBounds(CGMainDisplayID());
	*w = b.size.width;
	*h = b.size.height;
}

static double fleetBackingScale(void) {
	CGDirectDisplayID id = CGMainDisplayID();
	double pts = CGDisplayBounds(id).size.width;
	double px = (double)CGDisplayPixelsWide(id);
	if (pts < 1.0) return 1.0;
	return px / pts;
}
*/
import "C"

type darwinPointer struct {
	held   bool
	button pointerButton
	x, y   float64
}

func nativePointer() (pointerDevice, pointerOverlay) {
	return &darwinPointer{}, noopOverlay{}
}

func nativeMotionBounds() motionBounds {
	var w, h C.double
	C.fleetDisplaySize(&w, &h)
	if w < 1 {
		w = 1440
	}
	if h < 1 {
		h = 900
	}
	return motionBounds{0, 0, float64(w - 1), float64(h - 1)}
}

var darwinCapSize struct {
	w, h float64
}

func darwinBackingScale() float64 {
	s := float64(C.fleetBackingScale())
	if s < 1 {
		return 1
	}
	return s
}

func (p *darwinPointer) CursorPos() (float64, float64, error) {
	var x, y C.double
	C.fleetCursorPos(&x, &y)
	s := darwinBackingScale()
	return float64(x) * s, float64(y) * s, nil
}

func (p *darwinPointer) toPoints(x, y float64) (float64, float64) {
	var pw, ph C.double
	C.fleetDisplayPoints(&pw, &ph)
	cw, ch := darwinCapSize.w, darwinCapSize.h
	if cw > 1 && ch > 1 && pw > 1 && ph > 1 {
		return x * float64(pw) / cw, y * float64(ph) / ch
	}
	s := darwinBackingScale()
	return x / s, y / s
}

func darwinNeedAX() error {
	if C.fleetAXTrustedHID() == 0 {
		return desktopError{code: "os_permission", permission: "accessibility",
			msg: "fleet: enable Accessibility for Fleet Agent in System Settings → Privacy & Security"}
	}
	return nil
}

func (p *darwinPointer) MoveAbs(x, y float64) error {
	if err := darwinNeedAX(); err != nil {
		return err
	}
	p.x, p.y = x, y
	px, py := p.toPoints(x, y)
	dragged := 0
	btn := 0
	if p.held {
		dragged = 1
		btn = int(p.button)
	}
	C.fleetMouseMove(C.double(px), C.double(py), C.int(dragged), C.int(btn))
	return nil
}

func (p *darwinPointer) Button(button pointerButton, down bool) error {
	if err := darwinNeedAX(); err != nil {
		return err
	}
	p.button = button
	p.held = down
	px, py := p.toPoints(p.x, p.y)
	C.fleetMouseButton(C.double(px), C.double(py), C.int(button), boolInt(down))
	return nil
}

func boolInt(v bool) C.int {
	if v {
		return 1
	}
	return 0
}
