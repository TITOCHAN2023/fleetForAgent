//go:build darwin

package main

/*
#cgo LDFLAGS: -framework ApplicationServices -framework CoreGraphics -framework CoreFoundation
#include <ApplicationServices/ApplicationServices.h>
#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdint.h>
#include <stdlib.h>

static int fleetScreenTrusted(void) {
	return CGPreflightScreenCaptureAccess() ? 1 : 0;
}

static int fleetAXTrusted(void) {
	return AXIsProcessTrusted() ? 1 : 0;
}

static int fleetCaptureBGRA(uint8_t **out, int *w, int *h) {
	CGImageRef img = CGDisplayCreateImage(kCGDirectMainDisplay);
	if (!img) return -1;
	*w = (int)CGImageGetWidth(img);
	*h = (int)CGImageGetHeight(img);
	size_t bytes = (size_t)(*w) * (size_t)(*h) * 4;
	uint8_t *buf = (uint8_t *)malloc(bytes);
	if (!buf) { CFRelease(img); return -2; }
	CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
	CGContextRef ctx = CGBitmapContextCreate(buf, (size_t)*w, (size_t)*h, 8, (size_t)(*w) * 4, cs,
		kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
	CGColorSpaceRelease(cs);
	if (!ctx) { free(buf); CFRelease(img); return -3; }
	CGContextTranslateCTM(ctx, 0, *h);
	CGContextScaleCTM(ctx, 1, -1);
	CGContextDrawImage(ctx, CGRectMake(0, 0, *w, *h), img);
	CGContextRelease(ctx);
	CFRelease(img);
	*out = buf;
	return 0;
}

static void fleetScroll(int dx, int dy) {
	CGEventRef e = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 2, dy, dx);
	if (!e) return;
	CGEventPost(kCGHIDEventTap, e);
	CFRelease(e);
}

static void fleetTypeUTF8(const char *utf8) {
	if (!utf8) return;
	CFStringRef s = CFStringCreateWithCString(NULL, utf8, kCFStringEncodingUTF8);
	if (!s) return;
	CFIndex n = CFStringGetLength(s);
	UniChar buf[8];
	for (CFIndex i = 0; i < n; i++) {
		CFStringGetCharacters(s, CFRangeMake(i, 1), buf);
		CGEventRef down = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)0, true);
		CGEventRef up = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)0, false);
		if (down && up) {
			CGEventKeyboardSetUnicodeString(down, 1, buf);
			CGEventKeyboardSetUnicodeString(up, 1, buf);
			CGEventPost(kCGHIDEventTap, down);
			CGEventPost(kCGHIDEventTap, up);
		}
		if (down) CFRelease(down);
		if (up) CFRelease(up);
	}
	CFRelease(s);
}

static void fleetKeyCodes(const CGKeyCode *codes, int n) {
	if (!codes || n <= 0) return;
	if (n > 8) n = 8;
	for (int i = 0; i < n; i++) {
		CGEventRef e = CGEventCreateKeyboardEvent(NULL, codes[i], true);
		if (e) { CGEventPost(kCGHIDEventTap, e); CFRelease(e); }
	}
	for (int i = n - 1; i >= 0; i--) {
		CGEventRef e = CGEventCreateKeyboardEvent(NULL, codes[i], false);
		if (e) { CGEventPost(kCGHIDEventTap, e); CFRelease(e); }
	}
}
*/
import "C"
import (
	"image"
	"unsafe"
)

func desktopSupported() bool { return true }

func nativeCapture() (*image.RGBA, DisplayInfo, error) {
	if C.fleetScreenTrusted() == 0 {
		return nil, DisplayInfo{}, desktopError{
			code: "os_permission", permission: "screen_recording",
			msg: "fleet: enable Screen Recording for Fleet Agent in System Settings → Privacy & Security, then relaunch",
		}
	}
	var raw *C.uint8_t
	var w, h C.int
	if rc := C.fleetCaptureBGRA(&raw, &w, &h); rc != 0 || raw == nil || w < 1 || h < 1 {
		return nil, DisplayInfo{}, desktopError{code: "capture_failed", msg: "fleet: CGDisplayCreateImage failed"}
	}
	n := int(w) * int(h)
	src := unsafe.Slice((*byte)(unsafe.Pointer(raw)), n*4)
	img := image.NewRGBA(image.Rect(0, 0, int(w), int(h)))
	for i := 0; i < n; i++ {
		o := i * 4
		img.Pix[o+0] = src[o+2]
		img.Pix[o+1] = src[o+1]
		img.Pix[o+2] = src[o+0]
		img.Pix[o+3] = 255
	}
	C.free(unsafe.Pointer(raw))
	scale := darwinBackingScale()
	darwinCapSize.w, darwinCapSize.h = float64(w), float64(h)
	return img, DisplayInfo{ID: "primary", Width: int(w), Height: int(h), Scale: scale}, nil
}

func nativeScroll(x, y, dx, dy int) error {
	if C.fleetAXTrusted() == 0 {
		return desktopError{code: "os_permission", permission: "accessibility",
			msg: "fleet: enable Accessibility for Fleet Agent in System Settings → Privacy & Security"}
	}
	if err := pointerMoveAt(x, y); err != nil {
		return err
	}
	C.fleetScroll(C.int(dx), C.int(-dy))
	return nil
}

func nativeTypeText(text string) error {
	if C.fleetAXTrusted() == 0 {
		return desktopError{code: "os_permission", permission: "accessibility",
			msg: "fleet: enable Accessibility for Fleet Agent in System Settings → Privacy & Security"}
	}
	if text == "" {
		return nil
	}
	cstr := C.CString(text)
	defer C.free(unsafe.Pointer(cstr))
	C.fleetTypeUTF8(cstr)
	return nil
}

func nativeKey(spec string) error {
	if C.fleetAXTrusted() == 0 {
		return desktopError{code: "os_permission", permission: "accessibility",
			msg: "fleet: enable Accessibility for Fleet Agent in System Settings → Privacy & Security"}
	}
	names := splitKeySpec(spec)
	if len(names) == 0 {
		return desktopError{code: "bad_request", msg: "fleet: unknown key"}
	}
	codes := make([]C.CGKeyCode, 0, len(names))
	for _, n := range names {
		k, ok := darwinKeyCode(n)
		if !ok {
			return desktopError{code: "bad_request", msg: "fleet: unknown key " + n}
		}
		codes = append(codes, C.CGKeyCode(k))
	}
	C.fleetKeyCodes(&codes[0], C.int(len(codes)))
	return nil
}
