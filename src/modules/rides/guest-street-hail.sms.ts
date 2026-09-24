/** SMS copy for guest street-hail — codes and fares are always injected. */

export function guestStartCodeSms(code: string): string {
  return (
    `Your Hebir street pickup verification code is ${code}. ` +
    `Give this code to your driver to verify your pickup. ` +
    `This code expires in 5 minutes.`
  );
}

export function guestFareCompleteSms(args: {
  tripRef: string;
  fareEtb: string;
  paymentStatus: string;
}): string {
  return (
    `Thank you for riding with Hebir!\n\n` +
    `Your trip has been completed.\n\n` +
    `Trip ID: ${args.tripRef}\n` +
    `Total Fare: ${args.fareEtb} ETB\n` +
    `Payment Status: ${args.paymentStatus}\n\n` +
    `Thank you for choosing Hebir!`
  );
}

export function shortTripRef(rideId: string): string {
  const compact = rideId.replace(/-/g, '').slice(0, 6).toUpperCase();
  return `HBR${compact}`;
}

export function formatPaymentStatusLabel(status: string | null | undefined): string {
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
