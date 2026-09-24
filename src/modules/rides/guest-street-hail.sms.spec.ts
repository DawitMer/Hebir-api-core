import {
  formatPaymentStatusLabel,
  guestFareCompleteSms,
  guestStartCodeSms,
  shortTripRef,
} from './guest-street-hail.sms';

describe('guest street-hail SMS templates', () => {
  it('injects the live verification code', () => {
    const body = guestStartCodeSms('4829');
    expect(body).toContain('4829');
    expect(body).not.toContain('482916');
    expect(body).toContain('5 minutes');
  });

  it('builds fare completion SMS from finalized values', () => {
    const body = guestFareCompleteSms({
      tripRef: 'HBRABC123',
      fareEtb: '450.00',
      paymentStatus: 'Cash collected',
    });
    expect(body).toContain('Hebir');
    expect(body).toContain('HBRABC123');
    expect(body).toContain('450.00 ETB');
    expect(body).toContain('Cash collected');
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
});
