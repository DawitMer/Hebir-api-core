import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LocationController } from './location.controller';
import { DriverLocationHistory } from './entities/driver-location-history.entity';
import { DriverProfile } from '../rides/entities/driver-profile.entity';
import { Ride } from '../rides/entities/ride.entity';
import { SubscriptionModule } from '../subscription/subscription.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([DriverLocationHistory, DriverProfile, Ride]),
    SubscriptionModule,
    NotificationsModule,
  ],
  controllers: [LocationController],
})
export class LocationModule {}
