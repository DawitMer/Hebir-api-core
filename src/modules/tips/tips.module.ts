import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tip } from './entities/tip.entity';
import { Ride } from '../rides/entities/ride.entity';
import { PaymentRecord } from '../rides/entities/payment-record.entity';
import { DriverEarning } from '../rides/entities/driver-earning.entity';
import { TipsService } from './tips.service';
import { TipsController } from './tips.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Tip, Ride, PaymentRecord, DriverEarning]),
    NotificationsModule,
  ],
  controllers: [TipsController],
  providers: [TipsService],
  exports: [TipsService],
})
export class TipsModule {}
