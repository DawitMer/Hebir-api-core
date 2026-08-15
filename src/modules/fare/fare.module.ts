import { Module } from '@nestjs/common';
import { SubscriptionModule } from '../subscription/subscription.module';
import { FareService } from './fare.service';
import { FareController } from './fare.controller';

@Module({
  imports: [SubscriptionModule],
  controllers: [FareController],
  providers: [FareService],
  exports: [FareService],
})
export class FareModule {}
