package main

import (
	"fmt"
	"math"
)

// OpenAI Codex Computer Use cursor geometry, ported from the public
// reverse-engineering of SkyComputerUseService (iFurySt/open-codex-computer-use).
// API click(x,y) is only the endpoint; this file plans the path.

const (
	motionEps              = 0.001
	candidateHandleMin     = 50.0
	candidateHandleMax     = 520.0
	candidateArcMin        = 38.0
	candidateArcMax        = 440.0
	scoreOutOfBounds       = 45.0
	scoreExcessLengthW     = 320.0
	scoreAngleEnergyW      = 140.0
	scoreMaxAngleW         = 180.0
	scoreTotalTurnW        = 18.0
	distanceScalePrimary   = 0.41960295031576633
	directSpanScale        = 0.9
	sideBiasScale          = 0.65
	distanceScaleSecondary = 0.2765523188064277
	distanceScaleTertiary  = 0.5783555327868779
	minStepDistance        = 0.01
	springResponse         = 1.4
	springDamping          = 0.9
	verletDT               = 1.0 / 240.0
	verletIdleVel          = 28800.0
	closeEnoughProgress    = 1.0
	closeEnoughDistance    = 0.01
	hidSampleStride        = 2 // 240 Hz sim → 120 Hz HID
	measurePadding         = 20.0
)

var (
	guideLocal = vec2{-0.6946583704589973, 0.7193398003386512}
	tableA     = [3]float64{0.55, 1.00, 1.50}
	tableB     = [3]float64{0.40, 1.00, 1.55}
)

type vec2 struct{ X, Y float64 }

func (v vec2) add(o vec2) vec2        { return vec2{v.X + o.X, v.Y + o.Y} }
func (v vec2) sub(o vec2) vec2        { return vec2{v.X - o.X, v.Y - o.Y} }
func (v vec2) scale(s float64) vec2   { return vec2{v.X * s, v.Y * s} }
func (v vec2) length() float64        { return math.Hypot(v.X, v.Y) }
func (v vec2) perp() vec2             { return vec2{-v.Y, v.X} }
func (v vec2) norm() vec2 {
	n := v.length()
	if n <= 1e-9 {
		return vec2{1, 0}
	}
	return vec2{v.X / n, v.Y / n}
}

type motionBounds struct {
	MinX, MinY, MaxX, MaxY float64
}

func (b motionBounds) valid() bool {
	return b.MaxX > b.MinX && b.MaxY > b.MinY
}

func (b motionBounds) contains(p vec2, pad float64) bool {
	if !b.valid() {
		return true
	}
	return p.X >= b.MinX-pad && p.X <= b.MaxX+pad && p.Y >= b.MinY-pad && p.Y <= b.MaxY+pad
}

type cubicSeg struct {
	End, C1, C2 vec2
}

type motionPath struct {
	Start, End vec2
	Segs       []cubicSeg
}

type springConfig struct {
	Response, Damping, Stiffness, Drag, DT float64
}

type timedSample struct {
	T, Progress float64
	P           vec2
	Heading     vec2
}

func sampleCubic(p0, p1, p2, p3 vec2, t float64) vec2 {
	u := 1 - t
	u2 := u * u
	t2 := t * t
	return p0.scale(u2 * u).
		add(p1.scale(3 * u2 * t)).
		add(p2.scale(3 * u * t2)).
		add(p3.scale(t2 * t))
}

func sampleCubicTangent(p0, p1, p2, p3 vec2, t float64) vec2 {
	u := 1 - t
	return p1.sub(p0).scale(3 * u * u).
		add(p2.sub(p1).scale(6 * u * t)).
		add(p3.sub(p2).scale(3 * t * t)).
		norm()
}

func (p motionPath) sample(progress float64) (vec2, vec2) {
	if len(p.Segs) == 0 {
		return p.Start, vec2{1, 0}
	}
	clamped := progress
	if clamped < 0 {
		clamped = 0
	}
	if clamped > 1 {
		clamped = 1
	}
	n := len(p.Segs)
	var idx int
	var local float64
	if clamped >= 1 {
		idx = n - 1
		local = 1
	} else {
		scaled := clamped * float64(n)
		idx = int(scaled)
		if idx >= n {
			idx = n - 1
		}
		local = scaled - float64(idx)
	}
	seg := p.Segs[idx]
	start := p.Start
	if idx > 0 {
		start = p.Segs[idx-1].End
	}
	return sampleCubic(start, seg.C1, seg.C2, seg.End, local),
		sampleCubicTangent(start, seg.C1, seg.C2, seg.End, local)
}

type pathMeasure struct {
	Length, AngleEnergy, MaxAngle, TotalTurn float64
	InBounds                                 bool
}

func (p motionPath) measure(b motionBounds) pathMeasure {
	m := pathMeasure{InBounds: b.contains(p.Start, measurePadding)}
	prev := p.Start
	prevAngle := 0.0
	haveAngle := false
	steps := len(p.Segs) * 24
	if steps < 1 {
		steps = 1
	}
	for i := 1; i <= steps; i++ {
		pt, _ := p.sample(float64(i) / float64(steps))
		d := pt.sub(prev)
		step := d.length()
		if m.InBounds && !b.contains(pt, measurePadding) {
			m.InBounds = false
		}
		if step <= minStepDistance {
			continue
		}
		ang := math.Atan2(d.Y, d.X)
		m.Length += step
		if haveAngle {
			delta := ang - prevAngle
			for delta > math.Pi {
				delta -= 2 * math.Pi
			}
			for delta < -math.Pi {
				delta += 2 * math.Pi
			}
			m.AngleEnergy += delta * delta
			ad := math.Abs(delta)
			if ad > m.MaxAngle {
				m.MaxAngle = ad
			}
			m.TotalTurn += ad
		}
		prevAngle = ang
		haveAngle = true
		prev = pt
	}
	return m
}

type pathCandidate struct {
	ID    string
	Kind  string
	Score float64
	Path  motionPath
	Meas  pathMeasure
}

func clampFloat(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func clipRay(origin, dir vec2, b motionBounds) float64 {
	if !b.valid() {
		return math.Inf(1)
	}
	limit := math.Inf(1)
	if dir.X > 0 {
		limit = math.Min(limit, (b.MaxX-origin.X)/dir.X)
	} else if dir.X < 0 {
		limit = math.Min(limit, (b.MinX-origin.X)/dir.X)
	}
	if dir.Y > 0 {
		limit = math.Min(limit, (b.MaxY-origin.Y)/dir.Y)
	} else if dir.Y < 0 {
		limit = math.Min(limit, (b.MinY-origin.Y)/dir.Y)
	}
	if limit < 0 {
		return 0
	}
	return limit
}

func primaryExtents(distance float64) (start, end float64) {
	primary := distance * distanceScalePrimary
	direct := distance * directSpanScale
	secondary := distance * 0.15
	const low, high = 48.0, 640.0
	switch {
	case primary < low:
		return low, low
	case primary < high:
		return primary, direct
	case secondary < high:
		return high, low
	default:
		return high, high
	}
}

func handleExtent(distance float64) float64 {
	raw := distance * distanceScaleSecondary
	if raw < candidateHandleMin {
		return candidateHandleMin
	}
	if raw < 640 {
		return raw
	}
	return candidateHandleMax
}

func scoreCandidate(distance float64, m pathMeasure) float64 {
	excess := math.Max((m.Length/math.Max(distance, 1))-1, 0)
	out := 0.0
	if !m.InBounds {
		out = scoreOutOfBounds
	}
	return excess*scoreExcessLengthW +
		m.AngleEnergy*scoreAngleEnergyW +
		m.MaxAngle*scoreMaxAngleW +
		m.TotalTurn*scoreTotalTurnW +
		out
}

func makeCandidate(id, kind string, path motionPath, b motionBounds, distance float64) pathCandidate {
	m := path.measure(b)
	return pathCandidate{ID: id, Kind: kind, Score: scoreCandidate(distance, m), Path: path, Meas: m}
}

func buildMotionCandidates(start, end vec2, b motionBounds) []pathCandidate {
	delta := end.sub(start)
	distance := math.Max(delta.length(), motionEps)
	dir := delta.norm()
	localN := dir.perp()
	guide := dir.scale(guideLocal.X).add(localN.scale(guideLocal.Y))
	rev := guide.scale(-1)

	startPre, endPre := primaryExtents(distance)
	startExt := math.Min(startPre, clipRay(start, guide, b))
	endExt := math.Min(endPre, clipRay(end, rev, b))
	startScaled := math.Min(math.Max(startExt*sideBiasScale, 0), clipRay(start, guide, b))
	endScaled := math.Min(math.Max(endExt*sideBiasScale, 0), clipRay(end, rev, b))

	fullStart := start.add(guide.scale(startExt))
	fullEnd := end.sub(guide.scale(endExt))
	scaledStart := start.add(guide.scale(startScaled))
	scaledEnd := end.sub(guide.scale(endScaled))

	rawHandle := handleExtent(distance)
	rawArc := clampFloat(distance*distanceScaleTertiary, candidateArcMin, candidateArcMax)
	mid := vec2{(start.X + end.X) * 0.5, (start.Y + end.Y) * 0.5}
	signedN := localN
	cross := guide.Y*dir.X - guide.X*dir.Y
	if cross < 0 {
		signedN = signedN.scale(-1)
	}
	arcBias := guide.scale(startExt * sideBiasScale)
	fwd := dir.scale(distance).add(signedN.scale(rawArc))
	if fwd.length() < rawHandle || fwd.length() < motionEps {
		fwd = vec2{1, 0}
	} else {
		fwd = fwd.norm()
	}

	out := make([]pathCandidate, 0, 20)
	out = append(out, makeCandidate("base-full-guide", "base", motionPath{
		Start: start, End: end,
		Segs: []cubicSeg{{End: end, C1: fullStart, C2: fullEnd}},
	}, b, distance))
	out = append(out, makeCandidate("base-scaled-guide", "base", motionPath{
		Start: start, End: end,
		Segs: []cubicSeg{{End: end, C1: scaledStart, C2: scaledEnd}},
	}, b, distance))

	for _, outer := range tableA {
		anchorOff := signedN.scale(rawHandle * outer)
		for _, inner := range tableB {
			span := fwd.scale(rawArc * inner)
			for _, side := range []struct {
				id  string
				sgn float64
			}{{"positive", 1}, {"negative", -1}} {
				anchor := mid.add(arcBias).add(anchorOff.scale(side.sgn))
				arcIn := anchor.sub(span)
				arcOut := anchor.add(span)
				out = append(out, makeCandidate(
					"a"+formatScale(outer)+"-b"+formatScale(inner)+"-"+side.id,
					"arched",
					motionPath{
						Start: start, End: end,
						Segs: []cubicSeg{
							{End: anchor, C1: fullStart, C2: arcIn},
							{End: end, C1: arcOut, C2: fullEnd},
						},
					}, b, distance))
			}
		}
	}
	return out
}

func formatScale(v float64) string {
	return fmt.Sprintf("%.2f", v)
}

func chooseMotionPath(start, end vec2, b motionBounds) (motionPath, string) {
	cands := buildMotionCandidates(start, end, b)
	if len(cands) == 0 {
		return motionPath{Start: start, End: end}, "empty"
	}
	pool := make([]pathCandidate, 0, len(cands))
	for _, c := range cands {
		if c.Meas.InBounds {
			pool = append(pool, c)
		}
	}
	policy := "prefer_in_bounds_then_lowest_score"
	if len(pool) == 0 {
		pool = cands
		policy = "lowest_score"
	}
	best := pool[0]
	for _, c := range pool[1:] {
		if c.Score < best.Score {
			best = c
		}
	}
	return best.Path, policy
}

func buildSpring(response, damping float64) springConfig {
	if response <= 0 {
		response = springResponse
	}
	raw := math.Pow(2*math.Pi/response, 2)
	stiff := math.Min(raw, verletIdleVel)
	return springConfig{
		Response:  response,
		Damping:   damping,
		Stiffness: stiff,
		Drag:      2 * damping * math.Sqrt(stiff),
		DT:        verletDT,
	}
}

func springResponseForDistance(dist float64) float64 {
	// Official response is 1.4s regardless of distance; that stalls 8px tweaks.
	// Keep the spring character, scale duration like a soft Fitts law.
	return clampFloat(0.28+0.00072*dist, 0.28, 1.1)
}

func sampleSpringPath(path motionPath, response float64) []timedSample {
	cfg := buildSpring(response, springDamping)
	progress := 0.0
	vel, force := 0.0, 0.0
	t := 0.0
	maxSteps := int(2.0 / cfg.DT)
	out := make([]timedSample, 0, maxSteps/hidSampleStride+2)
	p, h := path.sample(0)
	out = append(out, timedSample{T: 0, Progress: 0, P: p, Heading: h})
	for step := 1; step <= maxSteps; step++ {
		half := cfg.DT * 0.5
		velHalf := vel + force*half
		progress = progress + velHalf*cfg.DT
		force = cfg.Stiffness*(1-progress) + (-cfg.Drag)*velHalf
		vel = velHalf + force*half
		t += cfg.DT
		if step%hidSampleStride == 0 || progress >= closeEnoughProgress {
			pt, hd := path.sample(progress)
			out = append(out, timedSample{T: t, Progress: progress, P: pt, Heading: hd})
		}
		if progress >= closeEnoughProgress && math.Abs(1-progress) <= closeEnoughDistance {
			end, eh := path.sample(1)
			if last := out[len(out)-1]; last.P.sub(end).length() > 0.5 {
				out = append(out, timedSample{T: t, Progress: 1, P: end, Heading: eh})
			} else {
				out[len(out)-1] = timedSample{T: t, Progress: 1, P: end, Heading: eh}
			}
			break
		}
	}
	return out
}

func planCursorMove(start, end vec2, b motionBounds) []timedSample {
	if start.sub(end).length() < 2.5 {
		return []timedSample{{T: 0, Progress: 1, P: end, Heading: vec2{1, 0}}}
	}
	path, _ := chooseMotionPath(start, end, b)
	return sampleSpringPath(path, springResponseForDistance(start.sub(end).length()))
}
