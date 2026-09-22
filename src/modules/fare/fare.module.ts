import { Module, forwardRef } from '@nestjs/common';
import { SubscriptionModule } from '../subscription/subscription.module';
import { OperationsModule } from '../operations/operations.module';
import { FareService } from './fare.service';
import { FareController } from './fare.controller';

@Module({
  imports: [SubscriptionModule, forwardRef(() => OperationsModule)],
  controllers: [FareController],
  providers: [FareService],
  exports: [FareService],
})
export class FareModule {}
