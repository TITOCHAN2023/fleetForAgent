//go:build darwin

package main

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

func (p *darwinPointer) CursorPos() (float64, float64, error) {
	var x, y C.double
	C.fleetCursorPos(&x, &y)
	return float64(x), float64(y), nil
}

func (p *darwinPointer) MoveAbs(x, y float64) error {
	p.x, p.y = x, y
	dragged := 0
	btn := 0
	if p.held {
		dragged = 1
		btn = int(p.button)
	}
	C.fleetMouseMove(C.double(x), C.double(y), C.int(dragged), C.int(btn))
	return nil
}

func (p *darwinPointer) Button(button pointerButton, down bool) error {
	p.button = button
	p.held = down
	C.fleetMouseButton(C.double(p.x), C.double(p.y), C.int(button), boolInt(down))
	return nil
}

func boolInt(v bool) C.int {
	if v {
		return 1
	}
	return 0
}
