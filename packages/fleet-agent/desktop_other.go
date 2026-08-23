//go:build !windows && !darwin && !linux

package main

import "image"

func desktopSupported() bool { return false }

func nativeCapture() (*image.RGBA, DisplayInfo, error) {
	return nil, DisplayInfo{}, desktopError{code: "no_session", msg: "fleet: desktop capture not supported"}
}
func nativeScroll(x, y, dx, dy int) error {
	return desktopError{code: "unsupported_action", msg: "fleet: no HID"}
}
func nativeTypeText(text string) error {
	return desktopError{code: "unsupported_action", msg: "fleet: no HID"}
}
func nativeKey(spec string) error {
	return desktopError{code: "unsupported_action", msg: "fleet: no HID"}
}

type otherPointer struct{}

func (otherPointer) CursorPos() (float64, float64, error) {
	return 0, 0, desktopError{code: "unsupported_action", msg: "fleet: no HID"}
}
func (otherPointer) MoveAbs(x, y float64) error {
	return desktopError{code: "unsupported_action", msg: "fleet: no HID"}
}
func (otherPointer) Button(button pointerButton, down bool) error {
	return desktopError{code: "unsupported_action", msg: "fleet: no HID"}
}

func nativePointer() (pointerDevice, pointerOverlay) {
	return otherPointer{}, noopOverlay{}
}

func nativeMotionBounds() motionBounds { return motionBounds{} }
