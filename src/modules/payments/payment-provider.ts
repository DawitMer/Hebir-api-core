import { PaymentStatus } from '../rides/entities/payment-record.entity';

/**
 * Processor-agnostic fare/tip settlement.
 *
 * Cash is the live Ethiopian default. Chapa / Telebirr adapters must not
 * pretend to succeed until merchant credentials exist
 * (WAITING_FOR_PROVIDER_SETUP).
 */
export const FARE_PAYMENT_PROVIDER = 'FARE_PAYMENT_PROVIDER';

export type SettleFareInput = {
  rideId: string;
  riderId: string;
  amountEtb: string;
  idempotencyKey: string;
};

export type SettleFareResult = {
  status: PaymentStatus;
  providerReference: string;
  processorId: string;
};

export interface PaymentProvider {
  readonly id: string;
  settleFare(input: SettleFareInput): Promise<SettleFareResult>;
  initializePayment?(input: SettleFareInput): Promise<SettleFareResult>;
  verifyPayment?(providerReference: string): Promise<SettleFareResult>;
  capturePayment?(providerReference: string): Promise<SettleFareResult>;
  refundPayment?(
    providerReference: string,
    amountEtb?: string,
  ): Promise<SettleFareResult>;
  handleWebhook?(payload: unknown, signature?: string): Promise<void>;
}
