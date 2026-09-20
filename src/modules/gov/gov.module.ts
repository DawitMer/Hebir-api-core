import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GovAccessLog } from './entities/access-log.entity';
import { DriverMonthlyExpenseReport } from './entities/driver-monthly-expense-report.entity';
import { GovLegalRequest } from './entities/gov-legal-request.entity';
import { GovLegalRequestEvent } from './entities/gov-legal-request-event.entity';
import { GovReportJob } from './entities/gov-report-job.entity';
import { Booking } from '../booking/entities/booking.entity';
import { DriverSubscription } from '../subscription/entities/driver-subscription.entity';
import { Trip } from '../matching/entities/trip.entity';
import { RiderRequest } from '../matching/entities/rider-request.entity';
import { UserAccount } from '../auth/entities/user-account.entity';
import { Vehicle } from '../rides/entities/vehicle.entity';
import { Ride } from '../rides/entities/ride.entity';
import { FareRecord } from '../rides/entities/fare-record.entity';
import { DriverVerification } from '../kyc/entities/driver-verification.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { PushModule } from '../push/push.module';
import { GovService } from './gov.service';
import { GovController } from './gov.controller';
import { DriverExpensesController } from './driver-expenses.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      GovAccessLog,
      DriverMonthlyExpenseReport,
      GovLegalRequest,
      GovLegalRequestEvent,
      GovReportJob,
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
    NotificationsModule,
    PushModule,
  ],
  controllers: [GovController, DriverExpensesController],
  providers: [GovService],
  exports: [GovService],
})
export class GovModule {}
