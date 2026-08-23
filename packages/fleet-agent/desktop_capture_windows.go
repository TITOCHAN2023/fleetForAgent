//go:build windows

package main

import (
	"fmt"
	"image"
	"unsafe"
)

const srcCopy = 0x00CC0020

func desktopSupported() bool { return true }

func nativeCapture() (*image.RGBA, DisplayInfo, error) {
	var (
		img  *image.RGBA
		info DisplayInfo
	)
	err := winDo(func() error {
		var e error
		img, info, e = capturePrimaryLocked()
		return e
	})
	if err != nil {
		return nil, DisplayInfo{}, err
	}
	return img, info, nil
}

func capturePrimaryLocked() (*image.RGBA, DisplayInfo, error) {
	w, _, _ := procGetSystemMetrics.Call(smCXScreen)
	h, _, _ := procGetSystemMetrics.Call(smCYScreen)
	if w < 2 || h < 2 {
		return nil, DisplayInfo{}, desktopError{code: "no_session", msg: "fleet: no interactive desktop"}
	}
	hdc, _, err := procGetDC.Call(0)
	if hdc == 0 {
		return nil, DisplayInfo{}, desktopError{code: "capture_failed", msg: fmt.Sprintf("GetDC: %v", err)}
	}
	defer procReleaseDC.Call(0, hdc)
	mem, _, err := procCreateCompatible.Call(hdc)
	if mem == 0 {
		return nil, DisplayInfo{}, desktopError{code: "capture_failed", msg: fmt.Sprintf("CreateCompatibleDC: %v", err)}
	}
	defer procDeleteDC.Call(mem)
	bi := bitmapInfo{
		Size:        40,
		Width:       int32(w),
		Height:      -int32(h),
		Planes:      1,
		BitCount:    32,
		Compression: biRGB,
	}
	var bits uintptr
	dib, _, err := procCreateDIBSection.Call(mem, uintptr(unsafe.Pointer(&bi)), dibRGBColors, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if dib == 0 || bits == 0 {
		return nil, DisplayInfo{}, desktopError{code: "capture_failed", msg: fmt.Sprintf("CreateDIBSection: %v", err)}
	}
	defer procDeleteObject.Call(dib)
	old, _, _ := procSelectObject.Call(mem, dib)
	bitblt := gdi32.NewProc("BitBlt")
	r, _, err := bitblt.Call(mem, 0, 0, w, h, hdc, 0, 0, srcCopy)
	if old != 0 {
		_, _, _ = procSelectObject.Call(mem, old)
	}
	if r == 0 {
		return nil, DisplayInfo{}, desktopError{code: "capture_failed", msg: fmt.Sprintf("BitBlt: %v", err)}
	}
	n := int(w) * int(h)
	src := unsafe.Slice((*byte)(unsafe.Pointer(bits)), n*4)
	img := image.NewRGBA(image.Rect(0, 0, int(w), int(h)))
	for i := 0; i < n; i++ {
		o := i * 4
		img.Pix[o+0] = src[o+2]
		img.Pix[o+1] = src[o+1]
		img.Pix[o+2] = src[o+0]
		img.Pix[o+3] = 255
	}
	return img, DisplayInfo{ID: "primary", Width: int(w), Height: int(h), Scale: 1}, nil
}

func nativeScroll(x, y, dx, dy int) error {
	if err := pointerMoveAt(x, y); err != nil {
		return err
	}
	const wheel = 0x0800
	const hwheel = 0x1000
	const delta = 120
	return winDo(func() error {
		if dy != 0 {
			if err := sendMouse(0, 0, wheel, uint32(int32(-dy*delta))); err != nil {
				return err
			}
		}
		if dx != 0 {
			if err := sendMouse(0, 0, hwheel, uint32(int32(dx*delta))); err != nil {
				return err
			}
		}
		return nil
	})
}

func nativeTypeText(text string) error {
	const unicode = 0x0004
	const keyup = 0x0002
	for _, r := range text {
		if err := sendUnicode(uint16(r), unicode); err != nil {
			return err
		}
		if err := sendUnicode(uint16(r), unicode|keyup); err != nil {
			return err
		}
	}
	return nil
}

func nativeKey(spec string) error {
	names := splitKeySpec(spec)
	if len(names) == 0 {
		return desktopError{code: "bad_request", msg: "fleet: unknown key"}
	}
	vks := make([]uint16, 0, len(names))
	for _, n := range names {
		vk, ok := windowsVK(n)
		if !ok {
			return desktopError{code: "bad_request", msg: "fleet: unknown key " + n}
		}
		vks = append(vks, vk)
	}
	const keydown, keyup = 0, 0x0002
	for _, vk := range vks {
		if err := sendVK(vk, keydown); err != nil {
			return err
		}
	}
	for i := len(vks) - 1; i >= 0; i-- {
		if err := sendVK(vks[i], keyup); err != nil {
			return err
		}
	}
	return nil
}

type winKeyInput struct {
	Type  uint32
	_     uint32
	VK    uint16
	Scan  uint16
	Flags uint32
	Time  uint32
	_pad  uint32
	Extra uintptr
	_     [8]byte
}

func sendUnicode(scan uint16, flags uint32) error {
	in := winKeyInput{Type: 1, Scan: scan, Flags: flags}
	n, _, err := procSendInput.Call(1, uintptr(unsafe.Pointer(&in)), unsafe.Sizeof(in))
	if n == 0 {
		return fmt.Errorf("SendInput: %v", err)
	}
	return nil
}

func sendVK(vk uint16, flags uint32) error {
	in := winKeyInput{Type: 1, VK: vk, Flags: flags}
	n, _, err := procSendInput.Call(1, uintptr(unsafe.Pointer(&in)), unsafe.Sizeof(in))
	if n == 0 {
		return fmt.Errorf("SendInput: %v", err)
	}
	return nil
}

func windowsVK(name string) (uint16, bool) {
	switch name {
	case "enter", "return":
		return 0x0D, true
	case "tab":
		return 0x09, true
	case "esc", "escape":
		return 0x1B, true
	case "backspace":
		return 0x08, true
	case "space":
		return 0x20, true
	case "delete", "del":
		return 0x2E, true
	case "up":
		return 0x26, true
	case "down":
		return 0x28, true
	case "left":
		return 0x25, true
	case "right":
		return 0x27, true
	case "home":
		return 0x24, true
	case "end":
		return 0x23, true
	case "pageup":
		return 0x21, true
	case "pagedown":
		return 0x22, true
	case "ctrl", "control":
		return 0x11, true
	case "alt":
		return 0x12, true
	case "shift":
		return 0x10, true
	case "win", "meta", "cmd":
		return 0x5B, true
	case "f1":
		return 0x70, true
	case "f2":
		return 0x71, true
	case "f3":
		return 0x72, true
	case "f4":
		return 0x73, true
	case "f5":
		return 0x74, true
	}
	if len(name) == 1 {
		c := name[0]
		if c >= 'a' && c <= 'z' {
			return uint16(c - 32), true
		}
		if c >= '0' && c <= '9' {
			return uint16(c), true
		}
	}
	return 0, false
}
