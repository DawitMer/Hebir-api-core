import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserAccount } from '../auth/entities/user-account.entity';
import { DriverProfile } from '../rides/entities/driver-profile.entity';
import { Vehicle } from '../rides/entities/vehicle.entity';
import { Ride } from '../rides/entities/ride.entity';
import { FareRecord } from '../rides/entities/fare-record.entity';
import { DriverVerification } from '../kyc/entities/driver-verification.entity';
import { AuditTrail } from '../kyc/entities/audit-trail.entity';
import { DriverExpense } from '../gov/entities/driver-expense.entity';
import { DriverLocationHistory } from '../location/entities/driver-location-history.entity';
import { IncidentsModule } from '../incidents/incidents.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserAccount,
      DriverProfile,
      Vehicle,
      Ride,
      FareRecord,
      DriverVerification,
      AuditTrail,
      DriverExpense,
      DriverLocationHistory,
    ]),
    IncidentsModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
