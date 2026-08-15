import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Trip } from './entities/trip.entity';
import { RiderRequest } from './entities/rider-request.entity';
import { Booking } from '../booking/entities/booking.entity';
import { MatchingService } from './matching.service';
import { MatchingController } from './matching.controller';
import { SubscriptionModule } from '../subscription/subscription.module';
import { FareModule } from '../fare/fare.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Trip, RiderRequest, Booking]),
    SubscriptionModule,
    FareModule,
  ],
  controllers: [MatchingController],
  providers: [MatchingService],
  exports: [MatchingService, TypeOrmModule],
})
export class MatchingModule {}
