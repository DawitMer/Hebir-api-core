package demand

import "testing"

func TestComputeLiveSurgeCases(t *testing.T) {
	cfg := DefaultConfig()

	t.Run("0 requests + 0 drivers → 1.0", func(t *testing.T) {
		r := ComputeLiveSurge(0, 0, 1, 1, cfg)
		if r.Multiplier != 1 {
			t.Fatalf("got %v", r.Multiplier)
		}
	})

	t.Run("0 requests + many drivers → 1.0", func(t *testing.T) {
		r := ComputeLiveSurge(0, 40, 1, 1, cfg)
		if r.Multiplier != 1 {
			t.Fatalf("got %v", r.Multiplier)
		}
	})

	t.Run("1 request + many drivers → 1.0", func(t *testing.T) {
		r := ComputeLiveSurge(1, 20, 1, 1, cfg)
		if r.Multiplier != 1 {
			t.Fatalf("got %v", r.Multiplier)
		}
	})

	t.Run("balanced many/many → 1.0", func(t *testing.T) {
		r := ComputeLiveSurge(10, 10, 1, 1, cfg)
		if r.Multiplier != 1 {
			t.Fatalf("got %v", r.Multiplier)
		}
	})

	t.Run("many requests + few drivers → surge", func(t *testing.T) {
		prev := 1.0
		r := ComputeLiveSurge(12, 3, prev, 1, cfg)
		for i := 0; i < 12; i++ {
			prev = r.Multiplier
			r = ComputeLiveSurge(12, 3, prev, 1, cfg)
		}
		if r.Multiplier < 1.5 {
			t.Fatalf("expected surge, got %v", r.Multiplier)
		}
	})

	t.Run("gradual increase with step cap", func(t *testing.T) {
		prev := 1.0
		for _, riders := range []int64{2, 4, 8, 16} {
			r := ComputeLiveSurge(riders, 2, prev, 1, cfg)
			if r.Multiplier-prev > cfg.MaxStepUp+1e-9 {
				t.Fatalf("jumped too far: %v → %v", prev, r.Multiplier)
			}
			prev = r.Multiplier
		}
		if prev <= 1 {
			t.Fatalf("expected growth, got %v", prev)
		}
	})

	t.Run("drivers arrive → surge falls", func(t *testing.T) {
		hot := ComputeLiveSurge(10, 2, 1.8, 1, cfg)
		for i := 0; i < 8; i++ {
			hot = ComputeLiveSurge(10, 2, hot.Multiplier, 1, cfg)
		}
		cool := hot
		for i := 0; i < 12; i++ {
			cool = ComputeLiveSurge(10, 12, cool.Multiplier, 1, cfg)
		}
		if cool.Multiplier >= hot.Multiplier {
			t.Fatalf("expected decrease")
		}
		if cool.Multiplier != 1 {
			t.Fatalf("expected 1.0, got %v", cool.Multiplier)
		}
	})

	t.Run("all demand gone → exactly 1.0 despite previous", func(t *testing.T) {
		r := ComputeLiveSurge(0, 1, 2.5, 2.0, cfg)
		if r.Multiplier != 1 {
			t.Fatalf("got %v", r.Multiplier)
		}
	})

	t.Run("adjacent independence", func(t *testing.T) {
		a := ComputeLiveSurge(10, 2, 1, 1, cfg)
		b := ComputeLiveSurge(0, 2, 1, 1, cfg)
		if a.Multiplier <= 1 || b.Multiplier != 1 {
			t.Fatalf("a=%v b=%v", a.Multiplier, b.Multiplier)
		}
	})
}

func TestDemandRatioZeroRiders(t *testing.T) {
	if DemandRatio(0, 0) != 0 {
		t.Fatal("expected 0")
	}
	if DemandRatio(5, 0) != 5 {
		t.Fatal("expected 5")
	}
}
