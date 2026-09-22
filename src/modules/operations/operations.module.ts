import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FareModule } from '../fare/fare.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { UserAccount } from '../auth/entities/user-account.entity';
import { AuditTrail } from '../kyc/entities/audit-trail.entity';
import { Ride } from '../rides/entities/ride.entity';
import { FareRecord } from '../rides/entities/fare-record.entity';
import {
  OpsDepartment,
  OpsPermission,
  OpsRole,
  OpsRolePermission,
  OpsStaffProfile,
} from './entities/ops-rbac.entities';
import {
  FareAdjustment,
  PricingVersion,
} from './entities/pricing-version.entity';
import { OpsRbacService } from './ops-rbac.service';
import { PermissionsGuard } from './permissions.guard';
import { PricingVersionsService } from './pricing-versions.service';
import { SurgeOpsService } from './surge-ops.service';
import { OperationsController } from './operations.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OpsDepartment,
      OpsPermission,
      OpsRole,
      OpsRolePermission,
      OpsStaffProfile,
      PricingVersion,
      FareAdjustment,
      UserAccount,
      AuditTrail,
      Ride,
      FareRecord,
    ]),
    forwardRef(() => FareModule),
    SubscriptionModule,
  ],
  controllers: [OperationsController],
  providers: [
    OpsRbacService,
    PricingVersionsService,
    SurgeOpsService,
    PermissionsGuard,
  ],
  exports: [
    OpsRbacService,
    PricingVersionsService,
    SurgeOpsService,
    PermissionsGuard,
  ],
})
export class OperationsModule {}
