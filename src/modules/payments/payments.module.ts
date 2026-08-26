import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CashPaymentProvider } from './cash.provider';
import { ChapaClient } from './chapa.client';
import { FARE_PAYMENT_PROVIDER } from './payment-provider';
import { UserAccount } from '../auth/entities/user-account.entity';

@Module({
  imports: [TypeOrmModule.forFeature([UserAccount])],
  providers: [
    CashPaymentProvider,
    ChapaClient,
    { provide: FARE_PAYMENT_PROVIDER, useExisting: CashPaymentProvider },
  ],
  exports: [FARE_PAYMENT_PROVIDER, CashPaymentProvider, ChapaClient],
})
export class PaymentsModule {}
