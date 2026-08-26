import { CashPaymentProvider } from './cash.provider';
import { PaymentStatus } from '../rides/entities/payment-record.entity';

describe('CashPaymentProvider', () => {
  it('settles a fare as cash_collected without calling a PSP', async () => {
    const provider = new CashPaymentProvider();
    const result = await provider.settleFare({
      rideId: 'ride-1',
      riderId: 'rider-1',
      amountEtb: '250',
      idempotencyKey: 'fare:ride-1',
    });
    expect(result.status).toBe(PaymentStatus.CASH_COLLECTED);
    expect(result.processorId).toBe('cash');
    expect(result.providerReference).toBe('cash:ride-1');
  });
});
