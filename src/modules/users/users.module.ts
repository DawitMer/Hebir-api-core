import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { UserAccount } from '../auth/entities/user-account.entity';
import { DriverProfile } from '../rides/entities/driver-profile.entity';
import { Vehicle } from '../rides/entities/vehicle.entity';
import { Ride } from '../rides/entities/ride.entity';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { DriverVerification } from '../kyc/entities/driver-verification.entity';
import { PushModule } from '../push/push.module';

@Module({
  imports: [
    AuthModule,
    PushModule,
    TypeOrmModule.forFeature([
      UserAccount,
      DriverProfile,
      Vehicle,
      Ride,
      DriverVerification,
    ]),
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
