/** SMS copy for guest street-hail — codes, trip details, and receipts. */

export function guestStartCodeSms(code: string): string {
  return (
    `Your Hebir street pickup verification code is ${code}. ` +
    `Give this code to your driver to verify your pickup. ` +
    `This code expires in 5 minutes.`
  );
}

/** Sent right after the guest verifies and the trip starts. */
export function guestTripStartedSms(args: {
  tripRef: string;
  pickup: string;
  dropoff: string;
  distanceKm: string;
}): string {
  return (
    `Hebir trip started.\n\n` +
    `Trip ID: ${args.tripRef}\n` +
    `From: ${args.pickup}\n` +
    `To: ${args.dropoff}\n` +
    `Distance: ${args.distanceKm} km\n\n` +
    `Have a safe ride with Hebir.`
  );
}

/** Final receipt after settlement — actual km and locked fare only. */
export function guestFareCompleteSms(args: {
  tripRef: string;
  pickup: string;
  dropoff: string;
  distanceKm: string;
  durationMinutes?: string | null;
  fareEtb: string;
  paymentStatus: string;
}): string {
  const durationLine =
    args.durationMinutes != null && args.durationMinutes !== ''
      ? `Duration: ${args.durationMinutes} min\n`
      : '';
  return (
    `Thank you for riding with Hebir!\n\n` +
    `Your trip has been completed.\n\n` +
    `Trip ID: ${args.tripRef}\n` +
    `From: ${args.pickup}\n` +
    `To: ${args.dropoff}\n` +
    `Distance: ${args.distanceKm} km\n` +
    durationLine +
    `Total Fare: ${args.fareEtb} ETB\n` +
    `Payment Status: ${args.paymentStatus}\n\n` +
    `Receipt — thank you for choosing Hebir!`
  );
}

export function shortTripRef(rideId: string): string {
  const compact = rideId.replace(/-/g, '').slice(0, 6).toUpperCase();
  return `HBR${compact}`;
}

export function formatPaymentStatusLabel(
  status: string | null | undefined,
): string {
  if (!status) return 'Pending';
  switch (status) {
    case 'cash_collected':
      return 'Cash collected';
    case 'cash_pending':
      return 'Cash pending';
    case 'succeeded':
      return 'Paid';
    case 'pending':
      return 'Pending';
    case 'failed':
      return 'Failed';
    default:
      return status.replace(/_/g, ' ');
  }
}

export function formatKm(metersOrKm: number, fromMeters = false): string {
  const km = fromMeters ? metersOrKm / 1000 : metersOrKm;
  if (!Number.isFinite(km) || km < 0) return '0.0';
  return (Math.round(km * 10) / 10).toFixed(1);
}

export function placeLabel(
  address: string | null | undefined,
  point: { lat: number; lng: number } | null | undefined,
): string {
  const trimmed = address?.trim();
  if (trimmed) return trimmed.slice(0, 80);
  if (point && Number.isFinite(point.lat) && Number.isFinite(point.lng)) {
    return `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`;
  }
  return 'Location';
}
