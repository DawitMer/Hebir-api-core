import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { DriverSubscription } from './entities/driver-subscription.entity';
import { PaymentEvent } from './entities/payment-event.entity';
import { SubscriptionStatusHistory } from './entities/status-history.entity';
import { Configuration } from './entities/configuration.entity';
import { Trip } from '../matching/entities/trip.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { SubscriptionService } from './subscription.service';
import { SubscriptionController } from './subscription.controller';
import { ConfigurationService } from './configuration.service';
import { SubscriptionAccessGuard } from '../../common/guards/subscription-access.guard';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([
      DriverSubscription,
      PaymentEvent,
      SubscriptionStatusHistory,
      Configuration,
      Trip,
    ]),
    NotificationsModule,
    PaymentsModule,
  ],
  controllers: [SubscriptionController],
  providers: [
    SubscriptionService,
    ConfigurationService,
    SubscriptionAccessGuard,
  ],
  exports: [SubscriptionService, ConfigurationService, SubscriptionAccessGuard],
})
export class SubscriptionModule {}
