import {
  formatKm,
  formatPaymentStatusLabel,
  guestFareCompleteSms,
  guestStartCodeSms,
  guestTripStartedSms,
  placeLabel,
  shortTripRef,
} from './guest-street-hail.sms';

describe('guest street-hail SMS templates', () => {
  it('injects the live verification code', () => {
    const body = guestStartCodeSms('4829');
    expect(body).toContain('4829');
    expect(body).not.toContain('482916');
    expect(body).toContain('5 minutes');
  });

  it('includes route details when the trip starts', () => {
    const body = guestTripStartedSms({
      tripRef: 'HBRABC123',
      pickup: 'Bole Airport',
      dropoff: 'Piassa',
      distanceKm: '8.4',
    });
    expect(body).toContain('Hebir');
    expect(body).toContain('Bole Airport');
    expect(body).toContain('Piassa');
    expect(body).toContain('8.4 km');
  });

  it('builds a receipt with km, places, fare, and payment status', () => {
    const body = guestFareCompleteSms({
      tripRef: 'HBRABC123',
      pickup: 'Bole',
      dropoff: 'Kazanchis',
      distanceKm: '6.2',
      durationMinutes: '18',
      fareEtb: '450.00',
      paymentStatus: 'Cash collected',
    });
    expect(body).toContain('Hebir');
    expect(body).toContain('HBRABC123');
    expect(body).toContain('Bole');
    expect(body).toContain('Kazanchis');
    expect(body).toContain('6.2 km');
    expect(body).toContain('18 min');
    expect(body).toContain('450.00 ETB');
    expect(body).toContain('Cash collected');
    expect(body).toContain('Receipt');
  });

  it('shortens ride ids for SMS', () => {
    expect(shortTripRef('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(
      'HBRA1B2C3',
    );
  });

  it('maps payment statuses without inventing paid', () => {
    expect(formatPaymentStatusLabel(undefined)).toBe('Pending');
    expect(formatPaymentStatusLabel('cash_collected')).toBe('Cash collected');
    expect(formatPaymentStatusLabel('pending')).toBe('Pending');
  });

  it('formats km and place labels', () => {
    expect(formatKm(6250, true)).toBe('6.3');
    expect(placeLabel('  Bole  ', null)).toBe('Bole');
    expect(placeLabel(null, { lat: 8.98, lng: 38.79 })).toContain('8.9800');
  });
});
