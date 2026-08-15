/**
 * Pure ranking for advanced ride-share matching.
 * Weights come from Neon configuration — not hardcoded in callers.
 */
export interface MatchScoreInput {
  waitingMinutes: number;
  detourMinutes: number;
  /** Rider ceiling − trip pricePerSeat (positive = cheaper than ceiling). */
  priceDifference: number;
  /** Live surge at pickup (≥ 1). */
  surgeMultiplier: number;
  waitWeight: number;
  detourWeight: number;
  priceWeight: number;
  /** Penalty for busy zones so riders aren't always pushed into hotspots. */
  surgeRankWeight: number;
}

export function computeMatchScore(input: MatchScoreInput): number {
  const pricePenalty = Math.max(0, -input.priceDifference);
  const surgePenalty = Math.max(0, input.surgeMultiplier - 1);
  return (
    input.waitWeight * input.waitingMinutes -
    input.detourWeight * input.detourMinutes -
    input.priceWeight * pricePenalty -
    input.surgeRankWeight * surgePenalty
  );
}
