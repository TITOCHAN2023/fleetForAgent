package main

import (
	"math"
	"testing"
)

func TestMotionBuildsTwentyCandidates(t *testing.T) {
	cands := buildMotionCandidates(vec2{80, 80}, vec2{900, 640}, motionBounds{0, 0, 1920, 1080})
	if len(cands) != 20 {
		t.Fatalf("got %d candidates, want 20 (2 base + 18 arched)", len(cands))
	}
	base, arched := 0, 0
	for _, c := range cands {
		switch c.Kind {
		case "base":
			base++
		case "arched":
			arched++
		}
	}
	if base != 2 || arched != 18 {
		t.Fatalf("kinds base=%d arched=%d", base, arched)
	}
}

func TestChosenPathIsCurvedNotTeleport(t *testing.T) {
	start, end := vec2{100, 700}, vec2{1100, 180}
	path, policy := chooseMotionPath(start, end, motionBounds{0, 0, 1440, 900})
	if policy == "empty" {
		t.Fatal("no path")
	}
	s, _ := path.sample(0)
	e, _ := path.sample(1)
	if s.sub(start).length() > 1 || e.sub(end).length() > 1 {
		t.Fatalf("endpoints %+v %+v want %+v %+v", s, e, start, end)
	}
	chord := end.sub(start)
	n := chord.norm().perp()
	maxOff := 0.0
	for i := 1; i < 40; i++ {
		p, _ := path.sample(float64(i) / 40)
		off := math.Abs(p.sub(start).X*n.X + p.sub(start).Y*n.Y)
		if off > maxOff {
			maxOff = off
		}
	}
	if maxOff < 8 {
		t.Fatalf("path too linear, max offset %.1f", maxOff)
	}
}

func TestSpringTimelineHasNoJumps(t *testing.T) {
	samples := planCursorMove(vec2{40, 40}, vec2{320, 360}, motionBounds{0, 0, 800, 600})
	if len(samples) < 20 {
		t.Fatalf("too few samples %d", len(samples))
	}
	end := samples[len(samples)-1]
	if end.P.sub(vec2{320, 360}).length() > 1.5 {
		t.Fatalf("did not settle at end: %+v", end.P)
	}
	for i := 1; i < len(samples); i++ {
		step := samples[i].P.sub(samples[i-1].P).length()
		if step >= 80 {
			t.Fatalf("teleport at %d: %.1f px", i, step)
		}
	}
}

func TestShortMoveDoesNotTakeFullSecond(t *testing.T) {
	samples := planCursorMove(vec2{10, 10}, vec2{11, 10.4}, motionBounds{})
	if len(samples) != 1 {
		t.Fatalf("tiny moves should snap, got %d", len(samples))
	}
	medium := planCursorMove(vec2{10, 10}, vec2{90, 40}, motionBounds{0, 0, 400, 300})
	if last := medium[len(medium)-1]; last.T > 0.7 {
		t.Fatalf("short move took %.2fs, too sluggish", last.T)
	}
}

func TestMouseAbsVirtualDesktop(t *testing.T) {
	virt := imageRect{X: -1920, Y: 0, Dx: 3840, Dy: 1080}
	primary := imageRect{X: 0, Y: 0, Dx: 1920, Dy: 1080}
	x, y := mouseAbs(0, 0, virt, primary)
	// primary origin is +1920 into the virtual span of 3840.
	wantF := 1920.0*65535/3839 + 0.5
	want := int(wantF)
	if x != want {
		t.Fatalf("absX=%d want %d", x, want)
	}
	if y != 0 {
		t.Fatalf("absY=%d want 0", y)
	}
	x2, y2 := mouseAbs(1919, 1079, virt, primary)
	if x2 <= x || y2 <= 0 {
		t.Fatalf("corner not greater: (%d,%d) vs (%d,%d)", x2, y2, x, y)
	}
}
