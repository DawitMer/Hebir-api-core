import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdsModule } from '../ads/ads.module';
import { AdCampaign } from '../ads/entities/ad-rewards.entity';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { AdvertiserAuthGuard } from './advertiser-auth.guard';
import { AdvertisersController } from './advertisers.controller';
import { AdvertisersService } from './advertisers.service';
import { Advertiser, AdvertiserPayment } from './entities/advertiser.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Advertiser, AdvertiserPayment, AdCampaign]),
    AdsModule,
    PaymentsModule,
    AuthModule,
  ],
  controllers: [AdvertisersController],
  providers: [AdvertisersService, AdvertiserAuthGuard],
})
export class AdvertisersModule {}
