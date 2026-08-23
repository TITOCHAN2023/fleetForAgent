package main

import (
	"math"
	"sync"
	"time"
)

type pointerButton int

const (
	pointerLeft pointerButton = iota
	pointerRight
	pointerMiddle
)

type pointerKind int

const (
	pointerMove pointerKind = iota
	pointerDown
	pointerUp
	pointerWait
)

type pointerEvent struct {
	Kind    pointerKind
	X, Y    float64
	Angle   float64
	Pulse   float64
	Pressed bool
	Trail   []vec2
	Button  pointerButton
	Sleep   time.Duration
}

type pointerScript struct {
	Events []pointerEvent
	End    vec2
	Heading vec2
}

type pointerDevice interface {
	CursorPos() (x, y float64, err error)
	MoveAbs(x, y float64) error
	Button(button pointerButton, down bool) error
}

type pointerOverlay interface {
	Show() error
	Paint(fr cursorFrame) error
	Hide()
}

var pointerRest = 380 * time.Millisecond

type pointerState struct {
	mu      sync.Mutex
	have    bool
	pos     vec2
	heading vec2
	trail   []vec2
}

var agentPointer pointerState

func (s *pointerState) last(fallback vec2) vec2 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.have {
		return s.pos
	}
	return fallback
}

func (s *pointerState) known() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.have
}

func (s *pointerState) lastHeading() vec2 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.heading.length() > 0.2 {
		return s.heading
	}
	return vec2{1, 0}
}

func (s *pointerState) remember(p, h vec2) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.have = true
	s.pos = p
	if h.length() > 0.2 {
		s.heading = h.norm()
	}
}

func (s *pointerState) pushTrail(p vec2) []vec2 {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.trail = append(s.trail, p)
	if len(s.trail) > cursorTrailN {
		s.trail = append([]vec2(nil), s.trail[len(s.trail)-cursorTrailN:]...)
	}
	out := make([]vec2, len(s.trail))
	copy(out, s.trail)
	return out
}

func (s *pointerState) clearTrail() {
	s.mu.Lock()
	s.trail = nil
	s.mu.Unlock()
}

func headingAngle(h vec2) float64 {
	if h.length() < 0.2 {
		return 0
	}
	return math.Atan2(h.Y, h.X)
}

func copyTrail(in []vec2) []vec2 {
	out := make([]vec2, len(in))
	copy(out, in)
	return out
}

func appendMove(script *pointerScript, samples []timedSample, trailFn func(vec2) []vec2) {
	var last vec2
	var lastH vec2
	for i, s := range samples {
		sleep := 8 * time.Millisecond
		if i > 0 {
			dt := s.T - samples[i-1].T
			if dt > 0 {
				sleep = time.Duration(dt * float64(time.Second))
			}
		} else {
			sleep = 0
		}
		tr := trailFn(s.P)
		script.Events = append(script.Events, pointerEvent{
			Kind:    pointerMove,
			X:       s.P.X,
			Y:       s.P.Y,
			Angle:   headingAngle(s.Heading),
			Trail:   copyTrail(tr),
			Sleep:   sleep,
		})
		last, lastH = s.P, s.Heading
	}
	script.End = last
	script.Heading = lastH
}

func planClickScript(from, to vec2, b motionBounds, button pointerButton, count int) pointerScript {
	if count < 1 {
		count = 1
	}
	var script pointerScript
	samples := planCursorMove(from, to, b)
	trail := make([]vec2, 0, cursorTrailN)
	push := func(p vec2) []vec2 {
		trail = append(trail, p)
		if len(trail) > cursorTrailN {
			trail = trail[len(trail)-cursorTrailN:]
		}
		return trail
	}
	appendMove(&script, samples, push)
	at := script.End
	if at.length() == 0 && len(samples) > 0 {
		at = samples[len(samples)-1].P
		script.End = at
	}
	ang := headingAngle(script.Heading)
	tr := copyTrail(trail)
	script.Events = append(script.Events, pointerEvent{
		Kind: pointerWait, X: at.X, Y: at.Y, Angle: ang, Trail: tr,
		Sleep: 60 * time.Millisecond,
	})
	for n := 0; n < count; n++ {
		if n > 0 {
			script.Events = append(script.Events, pointerEvent{
				Kind: pointerWait, X: at.X, Y: at.Y, Angle: ang, Trail: tr,
				Sleep: 80 * time.Millisecond,
			})
		}
		for _, pulse := range []struct {
			p      float64
			down   bool
			up     bool
			pressed bool
			wait   time.Duration
		}{
			{0.25, false, false, false, 16 * time.Millisecond},
			{0.7, true, false, true, 20 * time.Millisecond},
			{1.0, false, false, true, 18 * time.Millisecond},
			{0.55, false, false, true, 24 * time.Millisecond},
			{0.2, false, true, false, 20 * time.Millisecond},
			{0.0, false, false, false, 16 * time.Millisecond},
		} {
			ev := pointerEvent{
				Kind: pointerWait, X: at.X, Y: at.Y, Angle: ang,
				Pulse: pulse.p, Pressed: pulse.pressed, Trail: tr, Button: button,
				Sleep: pulse.wait,
			}
			if pulse.down {
				ev.Kind = pointerDown
			}
			if pulse.up {
				ev.Kind = pointerUp
			}
			script.Events = append(script.Events, ev)
		}
	}
	return script
}

func planMoveScript(from, to vec2, b motionBounds) pointerScript {
	var script pointerScript
	trail := make([]vec2, 0, cursorTrailN)
	push := func(p vec2) []vec2 {
		trail = append(trail, p)
		if len(trail) > cursorTrailN {
			trail = trail[len(trail)-cursorTrailN:]
		}
		return trail
	}
	appendMove(&script, planCursorMove(from, to, b), push)
	return script
}

func planDragScript(from, a, bpt vec2, bounds motionBounds) pointerScript {
	script := planMoveScript(from, a, bounds)
	at := script.End
	ang := headingAngle(script.Heading)
	tr := []vec2{}
	if n := len(script.Events); n > 0 {
		tr = copyTrail(script.Events[n-1].Trail)
	}
	script.Events = append(script.Events, pointerEvent{
		Kind: pointerWait, X: at.X, Y: at.Y, Angle: ang, Trail: tr,
		Sleep: 50 * time.Millisecond,
	})
	script.Events = append(script.Events, pointerEvent{
		Kind: pointerDown, X: at.X, Y: at.Y, Angle: ang, Pressed: true, Trail: tr, Button: pointerLeft,
		Sleep: 30 * time.Millisecond,
	})
	trail := tr
	push := func(p vec2) []vec2 {
		trail = append(trail, p)
		if len(trail) > cursorTrailN {
			trail = trail[len(trail)-cursorTrailN:]
		}
		return trail
	}
	drag := pointerScript{}
	appendMove(&drag, planCursorMove(a, bpt, bounds), push)
	for i := range drag.Events {
		drag.Events[i].Pressed = true
		drag.Events[i].Button = pointerLeft
	}
	script.Events = append(script.Events, drag.Events...)
	end := drag.End
	hang := headingAngle(drag.Heading)
	tr2 := []vec2{}
	if n := len(drag.Events); n > 0 {
		tr2 = copyTrail(drag.Events[n-1].Trail)
	}
	script.Events = append(script.Events, pointerEvent{
		Kind: pointerUp, X: end.X, Y: end.Y, Angle: hang, Trail: tr2, Button: pointerLeft,
		Sleep: 20 * time.Millisecond,
	})
	script.End = end
	script.Heading = drag.Heading
	return script
}

func playPointerOn(dev pointerDevice, overlay pointerOverlay, script pointerScript) error {
	if overlay != nil {
		if err := overlay.Show(); err != nil {
			return err
		}
		defer overlay.Hide()
	}
	paint := func(ev pointerEvent) {
		if overlay == nil {
			return
		}
		_ = overlay.Paint(cursorFrame{
			X: ev.X, Y: ev.Y, Angle: ev.Angle, Pulse: ev.Pulse, Trail: ev.Trail, Pressed: ev.Pressed,
		})
	}
	held := false
	var heldBtn pointerButton
	defer func() {
		if held {
			_ = dev.Button(heldBtn, false)
		}
	}()
	for _, ev := range script.Events {
		if ev.Sleep > 0 && ev.Kind != pointerMove {
			paint(ev)
			time.Sleep(ev.Sleep)
		}
		switch ev.Kind {
		case pointerMove:
			paint(ev)
			if err := dev.MoveAbs(ev.X, ev.Y); err != nil {
				return err
			}
			if ev.Sleep > 0 {
				time.Sleep(ev.Sleep)
			}
		case pointerDown:
			paint(ev)
			if err := dev.Button(ev.Button, true); err != nil {
				return err
			}
			held = true
			heldBtn = ev.Button
		case pointerUp:
			paint(ev)
			if err := dev.Button(ev.Button, false); err != nil {
				return err
			}
			held = false
		}
	}
	if len(script.Events) > 0 {
		last := script.Events[len(script.Events)-1]
		agentPointer.remember(vec2{last.X, last.Y}, script.Heading)
		if overlay != nil && pointerRest > 0 {
			paint(last)
			time.Sleep(pointerRest)
		}
	}
	return nil
}

func mouseAbs(natX, natY int, virt, primary imageRect) (absX, absY int) {
	dx := virt.Dx
	dy := virt.Dy
	if dx <= 1 {
		dx = 2
	}
	if dy <= 1 {
		dy = 2
	}
	x := float64(natX+primary.X-virt.X) * 65535 / float64(dx-1)
	y := float64(natY+primary.Y-virt.Y) * 65535 / float64(dy-1)
	if x < 0 {
		x = 0
	}
	if y < 0 {
		y = 0
	}
	if x > 65535 {
		x = 65535
	}
	if y > 65535 {
		y = 65535
	}
	return int(x + 0.5), int(y + 0.5)
}

type imageRect struct {
	X, Y, Dx, Dy int
}
