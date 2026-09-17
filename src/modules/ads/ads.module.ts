import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AdsController,
  AdsOpsController,
  DriverWalletController,
} from './ads.controller';
import { AdRewardsService } from './ads.service';
import {
  AdCampaign,
  AdRewardEvent,
  AdViewSession,
  DriverCashoutRequest,
  DriverWalletEntry,
  RiderAdProfile,
  RideAdSettlement,
} from './entities/ad-rewards.entity';
import { Ride } from '../rides/entities/ride.entity';
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AdCampaign,
      RiderAdProfile,
      AdViewSession,
      AdRewardEvent,
      RideAdSettlement,
      DriverWalletEntry,
      DriverCashoutRequest,
      Ride,
    ]),
  ],
  controllers: [AdsController, AdsOpsController, DriverWalletController],
  providers: [AdRewardsService],
  exports: [AdRewardsService],
})
export class AdsModule {}
