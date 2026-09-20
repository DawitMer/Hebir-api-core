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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RedisRateLimitGuard } from '../../common/rate-limit/redis-rate-limit.guard';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import { UserRole } from '../auth/entities/user-account.entity';
import { AdRewardsService } from './ads.service';
import {
  CampaignDto,
  CampaignReviewDto,
  CashoutDto,
  CompleteSessionDto,
  HeartbeatDto,
  RiderAdProfileDto,
} from './dto/ad.dto';
import { CampaignState, CashoutState } from './entities/ad-rewards.entity';

type User = { userId: string };

/** Heartbeats arrive every few seconds; the rest is a handful per trip. */
const AD_HEARTBEAT_LIMIT = {
  prefix: 'rl:ad-heartbeat',
  limit: 120,
  windowSec: 60,
  keyBy: 'user' as const,
};
const AD_ACTION_LIMIT = {
  prefix: 'rl:ad-action',
  limit: 30,
  windowSec: 60,
  keyBy: 'user' as const,
};

@Controller('ad-rewards')
@UseGuards(JwtAuthGuard)
export class AdsController {
  constructor(private readonly ads: AdRewardsService) {}

  /** Public-to-signed-in program facts for the consent screen. */
  @Get('program') program() {
    return this.ads.programSummary();
  }
  @Get('profile') profile(@CurrentUser() u: User) {
    return this.ads.profile(u.userId);
  }
  @Patch('profile') update(
    @CurrentUser() u: User,
    @Body() d: RiderAdProfileDto,
  ) {
    return this.ads.updateProfile(u.userId, d);
  }

  @UseGuards(RedisRateLimitGuard)
  @RateLimit(AD_ACTION_LIMIT)
  @Get('rides/:rideId/availability')
  availability(
    @CurrentUser() u: User,
    @Param('rideId', ParseUUIDPipe) r: string,
  ) {
    return this.ads.availability(r, u.userId);
  }

  @UseGuards(RedisRateLimitGuard)
  @RateLimit(AD_ACTION_LIMIT)
  @Post('rides/:rideId/sessions')
  start(@CurrentUser() u: User, @Param('rideId', ParseUUIDPipe) r: string) {
    return this.ads.start(r, u.userId);
  }

  @UseGuards(RedisRateLimitGuard)
  @RateLimit(AD_HEARTBEAT_LIMIT)
  @Post('sessions/:id/heartbeat')
  heartbeat(
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

  @UseGuards(RedisRateLimitGuard)
  @RateLimit(AD_ACTION_LIMIT)
  @Post('sessions/:id/click')
  click(
    @CurrentUser() u: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: CompleteSessionDto,
  ) {
    return this.ads.click(id, u.userId, d.token);
  }

  @UseGuards(RedisRateLimitGuard)
  @RateLimit(AD_ACTION_LIMIT)
  @Post('sessions/:id/complete')
  complete(
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
  @UseGuards(RedisRateLimitGuard)
  @RateLimit(AD_ACTION_LIMIT)
  @Post('cashouts')
  request(@CurrentUser() u: User, @Body() d: CashoutDto) {
    return this.ads.requestCashout(u.userId, d.amountMinor);
  }
}

@Controller('operations/ad-rewards')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdsOpsController {
  constructor(private readonly ads: AdRewardsService) {}

  /** `?state=pending_review,approved` filters; default lists everything. */
  @Get('campaigns') campaigns(@Query('state') state?: string) {
    const states = (state ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is CampaignState =>
        (Object.values(CampaignState) as string[]).includes(s),
      );
    return this.ads.listCampaigns(states);
  }

  @Get('campaigns/:id') async campaign(@Param('id', ParseUUIDPipe) id: string) {
    const c = await this.ads.getCampaign(id);
    return { ...c, stats: await this.ads.campaignStats(c) };
  }

  @Get('cashouts') cashouts() {
    return this.ads.listCashouts();
  }

  @Post('campaigns') create(@CurrentUser() u: User, @Body() d: CampaignDto) {
    return this.ads.upsertCampaign(
      undefined,
      {
        ...d,
        interests: d.interests ?? [],
        budgetMinor: String(d.budgetMinor),
        rewardMinor: this.ads.economics.rewardMinor,
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
    const { startsAt, endsAt, budgetMinor, rewardMinor: _r, ...safe } = d;
    void _r;
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

  @Post('campaigns/:id/review') review(
    @CurrentUser() u: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: CampaignReviewDto,
  ) {
    return this.ads.reviewCampaign(id, d.decision, u.userId, d.note);
  }

  @Post('campaigns/:id/pause') pause(
    @CurrentUser() u: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ads.setCampaignRunState(id, CampaignState.PAUSED, u.userId);
  }

  @Post('campaigns/:id/resume') resume(
    @CurrentUser() u: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ads.setCampaignRunState(id, CampaignState.ACTIVE, u.userId);
  }

  @Post('campaigns/:id/end') end(
    @CurrentUser() u: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ads.setCampaignRunState(id, CampaignState.ENDED, u.userId);
  }

  @Post('cashouts/:id/:state') reviewCashout(
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
