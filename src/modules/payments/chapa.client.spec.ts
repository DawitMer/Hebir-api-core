import * as crypto from 'crypto';
import { ChapaClient } from './chapa.client';

describe('ChapaClient signatures', () => {
  const secret = 'webhook-secret-at-least-24-chars';
  const client = new ChapaClient(
    {
      get: (key: string) =>
        key === 'CHAPA_WEBHOOK_SECRET' ? secret : undefined,
    } as never,
    { findOne: async () => null } as never,
  );

  it('accepts x-chapa-signature over the raw body', () => {
    const raw = Buffer.from('{"event":"charge.success"}');
    const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    expect(
      client.verifyWebhookSignature(raw, { 'x-chapa-signature': sig }),
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    const raw = Buffer.from('{"event":"charge.success"}');
    const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    expect(
      client.verifyWebhookSignature(Buffer.from('{"event":"no"}'), {
        'x-chapa-signature': sig,
      }),
    ).toBe(false);
  });

  it('parses driverId from tx_ref', () => {
    expect(
      client.driverIdFromTxRef('s.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.deadbeef'),
    ).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });
});
