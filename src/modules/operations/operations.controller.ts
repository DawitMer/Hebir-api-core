import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsIn,
  Min,
  ValidateNested,
} from 'class-validator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../auth/entities/user-account.entity';
import { PermissionsGuard } from './permissions.guard';
import { RequirePermissions } from './require-permissions.decorator';
import { OpsRbacService } from './ops-rbac.service';
import { PricingVersionsService } from './pricing-versions.service';
import { SurgeOpsService } from './surge-ops.service';
import type { FareRates } from '../fare/fare-rates';

class FareRatesDto {
  @IsNumber() @Min(0) initialFeeEtb: number;
  @IsNumber() @Min(0) perMeterEtb: number;
  @IsNumber() @Min(0) perMinuteEtb: number;
  @IsNumber() @Min(0) perWaitMinuteEtb: number;
  @IsNumber() @Min(0) minimumEtb: number;
  @IsNumber() @Min(1) surgeMaxMultiplier: number;
}

class CreatePricingDraftDto {
  @IsString() versionLabel: string;
  @IsObject() @ValidateNested() @Type(() => FareRatesDto) rates: FareRates;
  @IsOptional() @IsObject() vehicleMultipliers?: Record<string, number>;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() effectiveFrom?: string;
}

class UpdatePricingDraftDto {
  @IsOptional() @IsString() versionLabel?: string;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => FareRatesDto)
  rates?: FareRates;
  @IsOptional() @IsObject() vehicleMultipliers?: Record<string, number>;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() effectiveFrom?: string | null;
  @IsOptional() @IsIn(['draft', 'review']) status?: 'draft' | 'review';
}

class AdjustFareDto {
  @IsNumber() @Min(0) adjustedTotal: number;
  @IsString() reason: string;
  @IsOptional() @IsString() internalNote?: string;
}

class AssignRoleDto {
  @IsString() roleSlug: string;
}

class UpdateSurgeDto {
  @IsOptional() @IsBoolean() overrideEnabled?: boolean;
  @IsOptional() @IsNumber() @Min(1) overrideMultiplier?: number;
  @IsOptional() @IsObject() zoneOverrides?: Record<string, number>;
  @IsOptional() @IsBoolean() clearZoneOverrides?: boolean;
  @IsOptional() @IsNumber() @Min(1) maxMultiplier?: number;
  @IsOptional() @IsNumber() @Min(0) minActiveRiders?: number;
  @IsOptional() @IsNumber() @Min(0) maxStepUp?: number;
  @IsOptional() @IsNumber() @Min(0) maxStepDown?: number;
  @IsOptional() @IsNumber() @Min(0) neighborBlend?: number;
}

@Controller('operations')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles(UserRole.ADMIN)
export class OperationsController {
  constructor(
    private readonly rbac: OpsRbacService,
    private readonly pricing: PricingVersionsService,
    private readonly surge: SurgeOpsService,
  ) {}

  @Get('auth/me')
  me(@CurrentUser() user: { userId: string }) {
    return this.rbac.getMe(user.userId);
  }

  @Get('departments')
  @RequirePermissions('roles.view', 'staff.view', 'system.settings.view')
  departments() {
    return this.rbac.listDepartments();
  }

  @Get('roles')
  @RequirePermissions('roles.view', 'staff.view')
  roles() {
    return this.rbac.listRoles();
  }

  @Get('staff')
  @RequirePermissions('staff.view')
  staff() {
    return this.rbac.listStaff();
  }

  @Post('staff/:userId/role')
  @RequirePermissions('staff.edit', 'roles.manage')
  assignRole(
    @CurrentUser() user: { userId: string },
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: AssignRoleDto,
  ) {
    return this.rbac.assignRole(user.userId, userId, dto.roleSlug);
  }

  @Get('pricing')
  @RequirePermissions('pricing.view')
  listPricing(@Query('status') status?: string) {
    return this.pricing.list(status as never);
  }

  @Get('pricing/active')
  @RequirePermissions('pricing.view')
  activePricing() {
    return this.pricing.getActive();
  }

  @Get('pricing/:id')
  @RequirePermissions('pricing.view')
  getPricing(@Param('id', ParseUUIDPipe) id: string) {
    return this.pricing.get(id);
  }

  @Post('pricing')
  @RequirePermissions('pricing.edit')
  createPricing(
    @CurrentUser() user: { userId: string },
    @Body() dto: CreatePricingDraftDto,
  ) {
    return this.pricing.createDraft(user.userId, dto);
  }

  @Patch('pricing/:id')
  @RequirePermissions('pricing.edit')
  updatePricing(
    @CurrentUser() user: { userId: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePricingDraftDto,
  ) {
    return this.pricing.updateDraft(user.userId, id, dto);
  }

  @Post('pricing/:id/publish')
  @RequirePermissions('pricing.publish')
  publishPricing(
    @CurrentUser() user: { userId: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.pricing.publishAndActivate(user.userId, id);
  }

  @Post('rides/:rideId/fare-adjustment')
  @RequirePermissions('payments.refund', 'finance.view')
  adjustFare(
    @CurrentUser() user: { userId: string },
    @Param('rideId', ParseUUIDPipe) rideId: string,
    @Body() dto: AdjustFareDto,
  ) {
    return this.pricing.adjustFare(user.userId, rideId, dto);
  }

  @Get('surge')
  @RequirePermissions('pricing.view')
  getSurge() {
    return this.surge.getState();
  }

  @Patch('surge')
  @RequirePermissions('pricing.edit', 'pricing.publish')
  updateSurge(
    @CurrentUser() user: { userId: string },
    @Body() dto: UpdateSurgeDto,
  ) {
    return this.surge.update(user.userId, dto);
  }
}
