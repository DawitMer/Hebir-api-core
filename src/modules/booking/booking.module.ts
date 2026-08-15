import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { Booking } from './entities/booking.entity';
import { Trip } from '../matching/entities/trip.entity';
import { RiderRequest } from '../matching/entities/rider-request.entity';
import { BookingService } from './booking.service';
import { BookingController } from './booking.controller';
import { SubscriptionModule } from '../subscription/subscription.module';
import { FareModule } from '../fare/fare.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([Booking, Trip, RiderRequest]),
    SubscriptionModule,
    FareModule,
    NotificationsModule,
  ],
  controllers: [BookingController],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule {}
