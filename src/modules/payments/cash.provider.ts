import { Injectable } from '@nestjs/common';
import { PaymentStatus } from '../rides/entities/payment-record.entity';
import {
  PaymentProvider,
  SettleFareInput,
  SettleFareResult,
} from './payment-provider';

/**
 * Street cash: the driver collecting at destination *is* settlement.
 * No PSP, no webhook. Digital processors stay unwired until you create
 * a merchant account.
 */
@Injectable()
export class CashPaymentProvider implements PaymentProvider {
  readonly id = 'cash';

  async settleFare(input: SettleFareInput): Promise<SettleFareResult> {
    return {
      status: PaymentStatus.CASH_COLLECTED,
      providerReference: `cash:${input.rideId}`,
      processorId: this.id,
    };
  }
}
