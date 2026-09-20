import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DriverVerification } from './entities/driver-verification.entity';
import { DocumentSubmission } from './entities/document-submission.entity';
import { AuditTrail } from './entities/audit-trail.entity';
import { ComplianceAlert } from './entities/compliance-alert.entity';
import { KycReviewMessage } from './entities/kyc-review-message.entity';
import { KycService } from './kyc.service';
import { KycController } from './kyc.controller';
import { KycStorageService } from './kyc-storage.service';
import { SubscriptionModule } from '../subscription/subscription.module';
import { RedisModule } from '../../redis/redis.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UserAccount } from '../auth/entities/user-account.entity';
import { Vehicle } from '../rides/entities/vehicle.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DriverVerification,
      DocumentSubmission,
      AuditTrail,
      ComplianceAlert,
      KycReviewMessage,
      UserAccount,
      Vehicle,
    ]),
    SubscriptionModule,
    RedisModule,
    NotificationsModule,
  ],
  controllers: [KycController],
  providers: [KycService, KycStorageService],
  exports: [KycService, TypeOrmModule],
})
export class KycModule {}
