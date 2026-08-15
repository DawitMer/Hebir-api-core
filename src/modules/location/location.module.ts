import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LocationController } from './location.controller';
import { DriverLocationHistory } from './entities/driver-location-history.entity';
import { DriverProfile } from '../rides/entities/driver-profile.entity';
import { SubscriptionModule } from '../subscription/subscription.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([DriverLocationHistory, DriverProfile]),
    SubscriptionModule,
  ],
  controllers: [LocationController],
})
export class LocationModule {}
