import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { Ride } from './entities/ride.entity';
import { RideStatusEvent } from './entities/ride-status-event.entity';
import { RideMessage } from './entities/ride-message.entity';
import { FareRecord } from './entities/fare-record.entity';
import { Vehicle } from './entities/vehicle.entity';
import { DriverProfile } from './entities/driver-profile.entity';
import { DriverEarning } from './entities/driver-earning.entity';
import { PaymentRecord } from './entities/payment-record.entity';
import { Tip } from '../tips/entities/tip.entity';
import { UserAccount } from '../auth/entities/user-account.entity';
import { RidesService } from './rides.service';
import { RidesController } from './rides.controller';
import { DriverPresenceController } from './driver-presence.controller';
import { FareModule } from '../fare/fare.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { KycModule } from '../kyc/kyc.module';
import { DispatchQueueService } from './dispatch/dispatch.queue.service';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([
      Ride,
      RideStatusEvent,
      RideMessage,
      FareRecord,
      Vehicle,
      DriverProfile,
      DriverEarning,
      PaymentRecord,
      Tip,
      UserAccount,
    ]),
    FareModule,
    SubscriptionModule,
    NotificationsModule,
    KycModule,
    PaymentsModule,
  ],
  controllers: [RidesController, DriverPresenceController],
  providers: [RidesService, DispatchQueueService],
  exports: [RidesService],
})
export class RidesModule {}
