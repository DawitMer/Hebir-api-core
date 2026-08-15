import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserAccount } from '../auth/entities/user-account.entity';
import { DriverProfile } from '../rides/entities/driver-profile.entity';
import { Vehicle } from '../rides/entities/vehicle.entity';
import { Ride } from '../rides/entities/ride.entity';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserAccount, DriverProfile, Vehicle, Ride]),
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
