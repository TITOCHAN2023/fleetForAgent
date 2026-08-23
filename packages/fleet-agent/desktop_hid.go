package main

func resolvePointerStart(dev pointerDevice) vec2 {
	last := agentPointer.last(vec2{})
	x, y, err := dev.CursorPos()
	if err != nil {
		return last
	}
	os := vec2{x, y}
	if !agentPointer.known() || os.sub(last).length() > 2.5 {
		return os
	}
	return last
}

func pointerClickAt(x, y int, button pointerButton, count int) error {
	dev, overlay := nativePointer()
	from := resolvePointerStart(dev)
	to := vec2{float64(x), float64(y)}
	script := planClickScript(from, to, nativeMotionBounds(), button, count)
	return playPointerOn(dev, overlay, script)
}

func pointerMoveAt(x, y int) error {
	dev, overlay := nativePointer()
	from := resolvePointerStart(dev)
	to := vec2{float64(x), float64(y)}
	return playPointerOn(dev, overlay, planMoveScript(from, to, nativeMotionBounds()))
}

func pointerDragAt(x, y, x2, y2 int) error {
	dev, overlay := nativePointer()
	from := resolvePointerStart(dev)
	a := vec2{float64(x), float64(y)}
	b := vec2{float64(x2), float64(y2)}
	return playPointerOn(dev, overlay, planDragScript(from, a, b, nativeMotionBounds()))
}

type noopOverlay struct{}

func (noopOverlay) Show() error             { return nil }
func (noopOverlay) Paint(cursorFrame) error { return nil }
func (noopOverlay) Hide()                   {}
