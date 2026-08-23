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
