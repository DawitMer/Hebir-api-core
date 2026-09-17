import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../auth/entities/user-account.entity';
import { AdRewardsService } from './ads.service';
import {
  CampaignDto,
  CashoutDto,
  CompleteSessionDto,
  HeartbeatDto,
  RiderAdProfileDto,
} from './dto/ad.dto';
import { CashoutState } from './entities/ad-rewards.entity';
type User = { userId: string };
@Controller('ad-rewards')
@UseGuards(JwtAuthGuard)
export class AdsController {
  constructor(private readonly ads: AdRewardsService) {}
  @Get('profile') profile(@CurrentUser() u: User) {
    return this.ads.profile(u.userId);
  }
  @Patch('profile') update(
    @CurrentUser() u: User,
    @Body() d: RiderAdProfileDto,
  ) {
    return this.ads.updateProfile(u.userId, d);
  }
  @Get('rides/:rideId/availability') availability(
    @CurrentUser() u: User,
    @Param('rideId', ParseUUIDPipe) r: string,
  ) {
    return this.ads.availability(r, u.userId);
  }
  @Post('rides/:rideId/sessions') start(
    @CurrentUser() u: User,
    @Param('rideId', ParseUUIDPipe) r: string,
  ) {
    return this.ads.start(r, u.userId);
  }
  @Post('sessions/:id/heartbeat') heartbeat(
    @CurrentUser() u: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: HeartbeatDto,
  ) {
    return this.ads.heartbeat(
      id,
      u.userId,
      d.token,
      d.sequence,
      d.visibleSeconds,
      d.videoPlaying ?? true,
    );
  }
  @Post('sessions/:id/complete') complete(
    @CurrentUser() u: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: CompleteSessionDto,
  ) {
    return this.ads.complete(id, u.userId, d.token);
  }
  @Get('rides/:rideId/savings') savings(
    @CurrentUser() u: User,
    @Param('rideId', ParseUUIDPipe) r: string,
  ) {
    return this.ads.savings(r, u.userId);
  }
}
@Controller('driver/wallet')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.DRIVER)
export class DriverWalletController {
  constructor(private readonly ads: AdRewardsService) {}
  @Get() summary(@CurrentUser() u: User) {
    return this.ads.walletSummary(u.userId);
  }
  @Post('cashouts') request(@CurrentUser() u: User, @Body() d: CashoutDto) {
    return this.ads.requestCashout(u.userId, d.amountMinor);
  }
}
@Controller('operations/ad-rewards')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdsOpsController {
  constructor(private readonly ads: AdRewardsService) {}
  @Get('campaigns') campaigns() {
    return this.ads.listCampaigns();
  }
  @Get('cashouts') cashouts() {
    return this.ads.listCashouts();
  }
  @Post('campaigns') create(@CurrentUser() u: User, @Body() d: CampaignDto) {
    return this.ads.upsertCampaign(
      undefined,
      {
        ...d,
        budgetMinor: String(d.budgetMinor),
        rewardMinor: 300,
        startsAt: new Date(d.startsAt),
        endsAt: new Date(d.endsAt),
      },
      u.userId,
    );
  }
  @Patch('campaigns/:id') edit(
    @CurrentUser() u: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: Partial<CampaignDto>,
  ) {
    const { startsAt, endsAt, budgetMinor, ...safe } = d;
    return this.ads.upsertCampaign(
      id,
      {
        ...safe,
        budgetMinor:
          budgetMinor === undefined ? undefined : String(budgetMinor),
        startsAt: startsAt ? new Date(startsAt) : undefined,
        endsAt: endsAt ? new Date(endsAt) : undefined,
      },
      u.userId,
    );
  }
  @Post('cashouts/:id/:state') review(
    @CurrentUser() u: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('state') state: CashoutState,
    @Body() d: { paymentReference?: string; reviewNote?: string },
  ) {
    return this.ads.reviewCashout(
      id,
      state,
      u.userId,
      d.paymentReference,
      d.reviewNote,
    );
  }
}
