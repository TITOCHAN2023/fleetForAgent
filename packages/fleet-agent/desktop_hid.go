package main

func resolvePointerStart(dev pointerDevice) vec2 {
	cur := vec2{}
	if x, y, err := dev.CursorPos(); err == nil {
		cur = vec2{x, y}
	}
	return agentPointer.last(cur)
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
