import { IsEnum, IsNumberString, IsObject, IsString, IsUUID } from 'class-validator';
import { PaymentProvider } from '../entities/payment-event.entity';

export class PaymentWebhookDto {
  @IsEnum(PaymentProvider)
  provider: PaymentProvider;

  @IsString()
  providerReference: string;

  @IsUUID()
  driverId: string;

  @IsNumberString()
  amount: string;

  @IsObject()
  rawPayload: Record<string, unknown>;
}
