package demand

import "math"

// Config mirrors api-core surge.math DEFAULT_SURGE_CONFIG.
type Config struct {
	MaxMultiplier   float64
	MinActiveRiders int64
	MaxStepUp       float64
	MaxStepDown     float64
	NeighborBlend   float64
	Thresholds      []Threshold
}

type Threshold struct {
	MinRatio   float64
	Multiplier float64
}

func DefaultConfig() Config {
	return Config{
		MaxMultiplier:   2.5,
		MinActiveRiders: 2,
		MaxStepUp:       0.2,
		MaxStepDown:     0.3,
		NeighborBlend:   0.35,
		Thresholds: []Threshold{
			{0, 1.0},
			{1.15, 1.1},
			{1.35, 1.2},
			{1.6, 1.3},
			{2.0, 1.5},
			{2.75, 1.8},
			{3.5, 2.0},
			{4.5, 2.5},
		},
	}
}

type Result struct {
	DemandRatio      float64
	TargetMultiplier float64
	Multiplier       float64
}

func DemandRatio(riders, drivers int64) float64 {
	if riders <= 0 {
		return 0
	}
	if drivers < 1 {
		drivers = 1
	}
	return float64(riders) / float64(drivers)
}

func multiplierForRatio(ratio float64, cfg Config) float64 {
	if ratio <= 0 || math.IsNaN(ratio) {
		return 1
	}
	chosen := 1.0
	for _, step := range cfg.Thresholds {
		if ratio >= step.MinRatio {
			chosen = step.Multiplier
		}
	}
	if chosen < 1 {
		chosen = 1
	}
	if chosen > cfg.MaxMultiplier {
		chosen = cfg.MaxMultiplier
	}
	return chosen
}

func snapToNearestStep(value float64, cfg Config) float64 {
	best := 1.0
	bestDist := math.Abs(value - 1)
	for _, step := range cfg.Thresholds {
		m := step.Multiplier
		if m > cfg.MaxMultiplier {
			m = cfg.MaxMultiplier
		}
		d := math.Abs(value - m)
		if d < bestDist {
			bestDist = d
			best = m
		}
	}
	return best
}

// ComputeLiveSurge is the authoritative marketplace surge rule.
// activeRiders == 0 ⇒ 1.0 even if previousMultiplier or neighbors are hot.
func ComputeLiveSurge(riders, drivers int64, previous, neighborAvg float64, cfg Config) Result {
	if cfg.MaxMultiplier < 1 {
		cfg = DefaultConfig()
	}
	ratio := DemandRatio(riders, drivers)
	if riders == 0 || riders < cfg.MinActiveRiders {
		return Result{DemandRatio: ratio, TargetMultiplier: 1, Multiplier: 1}
	}

	target := multiplierForRatio(ratio, cfg)
	if neighborAvg >= 1 && cfg.NeighborBlend > 0 {
		w := cfg.NeighborBlend
		if w > 1 {
			w = 1
		}
		if w < 0 {
			w = 0
		}
		target = (1-w)*target + w*math.Max(1, neighborAvg)
		if target < 1 {
			target = 1
		}
		if target > cfg.MaxMultiplier {
			target = cfg.MaxMultiplier
		}
		target = snapToNearestStep(target, cfg)
	}

	prev := previous
	if prev < 1 || math.IsNaN(prev) {
		prev = 1
	}
	delta := target - prev
	next := target
	if delta > cfg.MaxStepUp {
		next = prev + cfg.MaxStepUp
	}
	if delta < -cfg.MaxStepDown {
		next = prev - cfg.MaxStepDown
	}
	if next < 1 {
		next = 1
	}
	if next > cfg.MaxMultiplier {
		next = cfg.MaxMultiplier
	}
	next = snapToNearestStep(next, cfg)
	next = math.Round(next*100) / 100

	return Result{DemandRatio: ratio, TargetMultiplier: target, Multiplier: next}
}
