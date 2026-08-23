//go:build windows

package main

import (
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	inputMouse              = 0
	mouseEventMove          = 0x0001
	mouseEventLeftDown      = 0x0002
	mouseEventLeftUp        = 0x0004
	mouseEventRightDown     = 0x0008
	mouseEventRightUp       = 0x0010
	mouseEventMiddleDown    = 0x0020
	mouseEventMiddleUp      = 0x0040
	mouseEventAbsolute      = 0x8000
	mouseEventVirtualDesk   = 0x4000
	smXVirtualScreen        = 76
	smYVirtualScreen        = 77
	smCXVirtualScreen       = 78
	smCYVirtualScreen       = 79
	smCXScreen              = 0
	smCYScreen              = 1
	wsExLayered             = 0x00080000
	wsExTransparent         = 0x00000020
	wsExTopmost             = 0x00000008
	wsExToolwindow          = 0x00000080
	wsExNoActivate          = 0x08000000
	wsPopup                 = 0x80000000
	swShowNoActivate        = 4
	swHide                  = 0
	ulwAlpha                = 0x00000002
	acSrcOver               = 0
	acSrcAlpha              = 1
	biRGB                   = 0
	dibRGBColors            = 0
)

var (
	user32               = syscall.NewLazyDLL("user32.dll")
	gdi32                = syscall.NewLazyDLL("gdi32.dll")
	procSendInput        = user32.NewProc("SendInput")
	procGetCursorPos     = user32.NewProc("GetCursorPos")
	procShowCursor       = user32.NewProc("ShowCursor")
	procGetSystemMetrics = user32.NewProc("GetSystemMetrics")
	procCreateWindowExW  = user32.NewProc("CreateWindowExW")
	procShowWindow       = user32.NewProc("ShowWindow")
	procUpdateLayered    = user32.NewProc("UpdateLayeredWindow")
	procRegisterClassExW = user32.NewProc("RegisterClassExW")
	procDefWindowProcW   = user32.NewProc("DefWindowProcW")
	procPeekMessageW     = user32.NewProc("PeekMessageW")
	procTranslateMessage = user32.NewProc("TranslateMessage")
	procDispatchMessageW = user32.NewProc("DispatchMessageW")
	procGetModuleHandleW = syscall.NewLazyDLL("kernel32.dll").NewProc("GetModuleHandleW")
	procGetDC            = user32.NewProc("GetDC")
	procReleaseDC        = user32.NewProc("ReleaseDC")
	procCreateCompatible = gdi32.NewProc("CreateCompatibleDC")
	procDeleteDC         = gdi32.NewProc("DeleteDC")
	procCreateDIBSection = gdi32.NewProc("CreateDIBSection")
	procSelectObject     = gdi32.NewProc("SelectObject")
	procDeleteObject     = gdi32.NewProc("DeleteObject")
)

type winPoint struct{ X, Y int32 }

type winMsg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      winPoint
	_       [4]byte
}

type winInput struct {
	Type uint32
	_    uint32
	Dx   int32
	Dy   int32
	Data uint32
	Flags uint32
	Time uint32
	Extra uintptr
}

type blendFn struct {
	Op, Flags, Alpha, Format byte
}

type winSize struct{ CX, CY int32 }

type bitmapInfo struct {
	Size, Width, Height int32
	Planes, BitCount    uint16
	Compression         uint32
	SizeImage           uint32
	XPels, YPels        int32
	ClrUsed, ClrImportant uint32
}

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   syscall.Handle
	Icon       syscall.Handle
	Cursor     syscall.Handle
	Background syscall.Handle
	MenuName   *uint16
	ClassName  *uint16
	IconSm     syscall.Handle
}

type winPointer struct {
	overlay *winOverlay
}

type winOverlay struct {
	hwnd     syscall.Handle
	hdc      syscall.Handle
	dib      syscall.Handle
	bits     uintptr
	shown    bool
	hiddenOS int
}

type winJob struct {
	fn   func() error
	done chan error
}

var (
	winHIDOnce sync.Once
	winJobs    = make(chan winJob)
	winPtr     *winPointer
)

func winDo(fn func() error) error {
	winHIDOnce.Do(startWinHID)
	j := winJob{fn: fn, done: make(chan error, 1)}
	select {
	case winJobs <- j:
	case <-time.After(2 * time.Second):
		return fmt.Errorf("hid thread stuck")
	}
	select {
	case err := <-j.done:
		return err
	case <-time.After(8 * time.Second):
		return fmt.Errorf("hid timeout")
	}
}

func pumpWinMsgs() {
	var m winMsg
	for {
		r, _, _ := procPeekMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0, 1)
		if r == 0 {
			return
		}
		_, _, _ = procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		_, _, _ = procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
}

func startWinHID() {
	winPtr = &winPointer{overlay: &winOverlay{}}
	ready := make(chan struct{})
	go func() {
		runtime.LockOSThread()
		defer func() { _, _, _ = procShowCursor.Call(1) }()
		if err := winPtr.overlay.create(); err != nil {
			winPtr.overlay = nil
		}
		close(ready)
		ticker := time.NewTicker(16 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case j, ok := <-winJobs:
				if !ok {
					return
				}
				pumpWinMsgs()
				j.done <- j.fn()
			case <-ticker.C:
				pumpWinMsgs()
			}
		}
	}()
	<-ready
}

func nativePointer() (pointerDevice, pointerOverlay) {
	winHIDOnce.Do(startWinHID)
	ov := pointerOverlay(noopOverlay{})
	if winPtr != nil && winPtr.overlay != nil && winPtr.overlay.hwnd != 0 {
		ov = winPtr.overlay
	}
	return winPtr, ov
}

func nativeMotionBounds() motionBounds {
	w, _, _ := procGetSystemMetrics.Call(uintptr(smCXScreen))
	h, _, _ := procGetSystemMetrics.Call(uintptr(smCYScreen))
	if w == 0 {
		w = 1920
	}
	if h == 0 {
		h = 1080
	}
	return motionBounds{0, 0, float64(w - 1), float64(h - 1)}
}

func virtAndPrimary() (virt, primary imageRect) {
	vx, _, _ := procGetSystemMetrics.Call(smXVirtualScreen)
	vy, _, _ := procGetSystemMetrics.Call(smYVirtualScreen)
	vw, _, _ := procGetSystemMetrics.Call(smCXVirtualScreen)
	vh, _, _ := procGetSystemMetrics.Call(smCYVirtualScreen)
	pw, _, _ := procGetSystemMetrics.Call(smCXScreen)
	ph, _, _ := procGetSystemMetrics.Call(smCYScreen)
	virt = imageRect{X: int(int32(vx)), Y: int(int32(vy)), Dx: int(vw), Dy: int(vh)}
	primary = imageRect{X: 0, Y: 0, Dx: int(pw), Dy: int(ph)}
	if virt.Dx < 1 {
		virt.Dx = primary.Dx
	}
	if virt.Dy < 1 {
		virt.Dy = primary.Dy
	}
	return virt, primary
}

func (p *winPointer) CursorPos() (float64, float64, error) {
	var (
		pt  winPoint
		err error
	)
	e := winDo(func() error {
		r, _, callErr := procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
		if r == 0 {
			err = callErr
		}
		return nil
	})
	if e != nil {
		return 0, 0, e
	}
	return float64(pt.X), float64(pt.Y), err
}

func (p *winPointer) MoveAbs(x, y float64) error {
	return winDo(func() error {
		virt, primary := virtAndPrimary()
		ax, ay := mouseAbs(int(x+0.5), int(y+0.5), virt, primary)
		return sendMouse(int32(ax), int32(ay), mouseEventMove|mouseEventAbsolute|mouseEventVirtualDesk, 0)
	})
}

func (p *winPointer) Button(button pointerButton, down bool) error {
	return winDo(func() error {
		var flags uint32
		switch button {
		case pointerRight:
			if down {
				flags = mouseEventRightDown
			} else {
				flags = mouseEventRightUp
			}
		case pointerMiddle:
			if down {
				flags = mouseEventMiddleDown
			} else {
				flags = mouseEventMiddleUp
			}
		default:
			if down {
				flags = mouseEventLeftDown
			} else {
				flags = mouseEventLeftUp
			}
		}
		return sendMouse(0, 0, flags, 0)
	})
}

func sendMouse(dx, dy int32, flags uint32, data uint32) error {
	in := winInput{Type: inputMouse, Dx: dx, Dy: dy, Data: data, Flags: flags}
	n, _, err := procSendInput.Call(1, uintptr(unsafe.Pointer(&in)), unsafe.Sizeof(in))
	if n == 0 {
		return fmt.Errorf("SendInput: %v", err)
	}
	return nil
}

func overlayWndProc(hwnd syscall.Handle, msg uint32, wparam, lparam uintptr) uintptr {
	r, _, _ := procDefWindowProcW.Call(uintptr(hwnd), uintptr(msg), wparam, lparam)
	return r
}

func (o *winOverlay) create() error {
	runtime.LockOSThread()
	className, err := syscall.UTF16PtrFromString("FleetAgentCursor")
	if err != nil {
		return err
	}
	hInst, _, _ := procGetModuleHandleW.Call(0)
	wc := wndClassEx{
		Size:      uint32(unsafe.Sizeof(wndClassEx{})),
		WndProc:   syscall.NewCallback(overlayWndProc),
		Instance:  syscall.Handle(hInst),
		ClassName: className,
	}
	_, _, _ = procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	ex := uintptr(wsExLayered | wsExTransparent | wsExTopmost | wsExToolwindow | wsExNoActivate)
	hwnd, _, err := procCreateWindowExW.Call(
		ex,
		uintptr(unsafe.Pointer(className)),
		0,
		uintptr(wsPopup),
		0, 0, cursorCanvas, cursorCanvas,
		0, 0, hInst, 0,
	)
	if hwnd == 0 {
		return fmt.Errorf("CreateWindowEx: %v", err)
	}
	o.hwnd = syscall.Handle(hwnd)

	screenDC, _, _ := procGetDC.Call(0)
	hdc, _, _ := procCreateCompatible.Call(screenDC)
	_, _, _ = procReleaseDC.Call(0, screenDC)
	bi := bitmapInfo{
		Size:        40,
		Width:       cursorCanvas,
		Height:      -cursorCanvas, // top-down
		Planes:      1,
		BitCount:    32,
		Compression: biRGB,
	}
	var bits uintptr
	dib, _, err := procCreateDIBSection.Call(hdc, uintptr(unsafe.Pointer(&bi)), dibRGBColors, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if dib == 0 {
		return fmt.Errorf("CreateDIBSection: %v", err)
	}
	o.bits = bits
	o.dib = syscall.Handle(dib)
	o.hdc = syscall.Handle(hdc)
	_, _, _ = procSelectObject.Call(hdc, dib)
	return nil
}

func (o *winOverlay) Show() error {
	return winDo(func() error {
		if o == nil || o.hwnd == 0 {
			return nil
		}
		if !o.shown {
			_, _, _ = procShowWindow.Call(uintptr(o.hwnd), swShowNoActivate)
			r, _, _ := procShowCursor.Call(0)
			o.hiddenOS = int(int32(r))
			o.shown = true
		}
		return nil
	})
}

func (o *winOverlay) Hide() {
	_ = winDo(func() error {
		if o == nil || o.hwnd == 0 || !o.shown {
			return nil
		}
		_, _, _ = procShowWindow.Call(uintptr(o.hwnd), swHide)
		_, _, _ = procShowCursor.Call(1)
		o.shown = false
		return nil
	})
}

func (o *winOverlay) Paint(fr cursorFrame) error {
	return winDo(func() error {
		if o == nil || o.hwnd == 0 || o.bits == 0 {
			return nil
		}
		img := drawCursorOverlay(fr)
		bgra := premultiplyBGRA(img)
		dst := unsafe.Slice((*byte)(unsafe.Pointer(o.bits)), cursorCanvas*cursorCanvas*4)
		copy(dst, bgra)
		pos := winPoint{X: int32(fr.X+0.5) - cursorHotX, Y: int32(fr.Y+0.5) - cursorHotY}
		size := winSize{CX: cursorCanvas, CY: cursorCanvas}
		src := winPoint{}
		blend := blendFn{Op: acSrcOver, Alpha: 255, Format: acSrcAlpha}
		_, _, _ = procUpdateLayered.Call(
			uintptr(o.hwnd),
			0,
			uintptr(unsafe.Pointer(&pos)),
			uintptr(unsafe.Pointer(&size)),
			uintptr(o.hdc),
			uintptr(unsafe.Pointer(&src)),
			0,
			uintptr(unsafe.Pointer(&blend)),
			ulwAlpha,
		)
		return nil
	})
}
