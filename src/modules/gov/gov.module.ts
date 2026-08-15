import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GovAccessLog } from './entities/access-log.entity';
import { DriverExpense } from './entities/driver-expense.entity';
import { Booking } from '../booking/entities/booking.entity';
import { DriverSubscription } from '../subscription/entities/driver-subscription.entity';
import { Trip } from '../matching/entities/trip.entity';
import { RiderRequest } from '../matching/entities/rider-request.entity';
import { UserAccount } from '../auth/entities/user-account.entity';
import { Vehicle } from '../rides/entities/vehicle.entity';
import { Ride } from '../rides/entities/ride.entity';
import { FareRecord } from '../rides/entities/fare-record.entity';
import { DriverVerification } from '../kyc/entities/driver-verification.entity';
import { GovService } from './gov.service';
import { GovController } from './gov.controller';
import { DriverExpensesController } from './driver-expenses.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      GovAccessLog,
      DriverExpense,
      Booking,
      DriverSubscription,
      Trip,
      RiderRequest,
      UserAccount,
      Vehicle,
      Ride,
      FareRecord,
      DriverVerification,
    ]),
  ],
  controllers: [GovController, DriverExpensesController],
  providers: [GovService],
})
export class GovModule {}
