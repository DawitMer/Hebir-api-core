import {
  chooseChargedSettlement,
  RideSettlementStatus,
} from './settlement-policy';
import { settleTripMeterDistance } from './gps-gap-settlement';
import type { FareBreakdown } from '../fare/fare.service';
import type { FareRates } from '../fare/fare-rates';

const rates: FareRates = {
  initialFeeEtb: 50,
  perMeterEtb: 0.01,
  perMinuteEtb: 1,
  perWaitMinuteEtb: 0,
  minimumEtb: 50,
  surgeMaxMultiplier: 2.5,
};

function fare(total: number, distanceKm = 5): FareBreakdown {
  return {
    initialFee: 50,
    distanceCharge: Math.max(0, total - 50),
    timeCharge: 0,
    waitCharge: 0,
    subtotal: total,
    surgeMultiplier: 1,
    vehicleMultiplier: 1,
    total,
    rates,
    durationMinutes: 20,
    distanceMeters: Math.round(distanceKm * 1000),
    waitMinutes: 0,
    platformFee: 0,
    base: 50,
  };
}

describe('chooseChargedSettlement', () => {
  const pickup = { lat: 8.98, lng: 38.75 };
  const dropoff = { lat: 9.01, lng: 38.76 };

  it('keeps a continuous meter as metered', () => {
    const meter = settleTripMeterDistance({
      recordedDistanceM: 4200,
      lastFix: dropoff,
      dropoff,
      quotedDistanceM: 4500,
      hasGaps: false,
      lastFixAgeMs: 5_000,
    });
    const result = chooseChargedSettlement({
      meter,
      meteredFare: fare(120),
      quotedFare: fare(130),
      quotedDistanceM: 4500,
    });
    expect(result.status).toBe(RideSettlementStatus.METERED);
    expect(result.fare.total).toBe(120);
    expect(result.estimateReason).toBeNull();
  });

  it('caps a gap estimate at the quoted fare', () => {
    const meter = settleTripMeterDistance({
      recordedDistanceM: 800,
      lastFix: pickup,
      dropoff,
      quotedDistanceM: 4000,
      hasGaps: true,
      lastFixAgeMs: 30_000,
    });
    const result = chooseChargedSettlement({
      meter,
      meteredFare: fare(200),
      quotedFare: fare(150),
      quotedDistanceM: 4000,
    });
    expect(result.status).toBe(RideSettlementStatus.ESTIMATED);
    expect(result.estimateReason).toBe('gps_gap');
    expect(result.fare.total).toBe(150);
    expect(result.uncappedFareTotal).toBe(200);
    expect(result.quotedFareTotal).toBe(150);
  });

  it('keeps an estimate below the quote (shorter than promised)', () => {
    const meter = settleTripMeterDistance({
      recordedDistanceM: 800,
      lastFix: pickup,
      dropoff,
      quotedDistanceM: 4000,
      hasGaps: true,
      lastFixAgeMs: 30_000,
    });
    const result = chooseChargedSettlement({
      meter,
      meteredFare: fare(90),
      quotedFare: fare(150),
      quotedDistanceM: 4000,
    });
    expect(result.fare.total).toBe(90);
    expect(result.status).toBe(RideSettlementStatus.ESTIMATED);
  });

  it('bills the quoted fare when there are zero accepted GPS meters', () => {
    const meter = settleTripMeterDistance({
      recordedDistanceM: 0,
      lastFix: pickup,
      dropoff,
      quotedDistanceM: 5000,
      hasGaps: false,
      lastFixAgeMs: 180_000,
    });
    // Stale zero-meter still comes back estimated from the gap helper;
    // the policy must force the quote regardless of the chord fill.
    const result = chooseChargedSettlement({
      meter: { ...meter, recordedDistanceM: 0 },
      meteredFare: fare(999),
      quotedFare: fare(140),
      quotedDistanceM: 5000,
    });
    expect(result.status).toBe(RideSettlementStatus.ESTIMATED);
    expect(result.estimateReason).toBe('zero_gps');
    expect(result.fare.total).toBe(140);
    expect(result.billedDistanceM).toBe(5000);
  });
});
