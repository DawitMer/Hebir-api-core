import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { RedisRateLimitGuard } from '../../common/rate-limit/redis-rate-limit.guard';
import {
  RateLimit,
  RateLimitPresets,
} from '../../common/rate-limit/rate-limit.decorator';
import { ChapaClient } from '../payments/chapa.client';
import { CampaignState } from '../ads/entities/ad-rewards.entity';
import {
  AdvertiserAuthGuard,
  AdvertiserPrincipal,
} from './advertiser-auth.guard';
import { AdvertisersService } from './advertisers.service';
import {
  AdvertiserCampaignDto,
  AdvertiserCampaignUpdateDto,
  AdvertiserLoginDto,
  AdvertiserRegisterDto,
} from './dto/advertiser.dto';

const CurrentAdvertiser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AdvertiserPrincipal =>
    ctx.switchToHttp().getRequest().advertiser,
);

const AUTH_LIMIT = {
  prefix: 'rl:advertiser-auth',
  limit: 10,
  windowSec: 600,
  keyBy: 'ip' as const,
};
const WRITE_LIMIT = {
  prefix: 'rl:advertiser-write',
  limit: 30,
  windowSec: 60,
  keyBy: 'ip' as const,
};

@Controller('advertisers')
export class AdvertisersController {
  constructor(
    private readonly advertisers: AdvertisersService,
    private readonly chapa: ChapaClient,
  ) {}

  // ---- public

  @Get('pricing') pricing() {
    return this.advertisers.pricing();
  }

  @UseGuards(RedisRateLimitGuard)
  @RateLimit(AUTH_LIMIT)
  @Post('register')
  register(@Body() dto: AdvertiserRegisterDto) {
    return this.advertisers.register(dto);
  }

  @UseGuards(RedisRateLimitGuard)
  @RateLimit(AUTH_LIMIT)
  @Post('login')
  login(@Body() dto: AdvertiserLoginDto) {
    return this.advertisers.login(dto);
  }

  // ---- signed-in advertiser

  @UseGuards(AdvertiserAuthGuard)
  @Get('me')
  me(@CurrentAdvertiser() a: AdvertiserPrincipal) {
    return this.advertisers.me(a.advertiserId);
  }

  @UseGuards(AdvertiserAuthGuard)
  @Get('campaigns')
  campaigns(@CurrentAdvertiser() a: AdvertiserPrincipal) {
    return this.advertisers.listCampaigns(a.advertiserId);
  }

  @UseGuards(AdvertiserAuthGuard, RedisRateLimitGuard)
  @RateLimit(WRITE_LIMIT)
  @Post('campaigns')
  create(
    @CurrentAdvertiser() a: AdvertiserPrincipal,
    @Body() dto: AdvertiserCampaignDto,
  ) {
    return this.advertisers.createCampaign(a.advertiserId, dto);
  }

  @UseGuards(AdvertiserAuthGuard, RedisRateLimitGuard)
  @RateLimit(WRITE_LIMIT)
  @Patch('campaigns/:id')
  update(
    @CurrentAdvertiser() a: AdvertiserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdvertiserCampaignUpdateDto,
  ) {
    return this.advertisers.updateCampaign(a.advertiserId, id, dto);
  }

  @UseGuards(AdvertiserAuthGuard, RedisRateLimitGuard)
  @RateLimit(WRITE_LIMIT)
  @Post('campaigns/:id/pause')
  pause(
    @CurrentAdvertiser() a: AdvertiserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.advertisers.setRunState(
      a.advertiserId,
      id,
      CampaignState.PAUSED,
    );
  }

  @UseGuards(AdvertiserAuthGuard, RedisRateLimitGuard)
  @RateLimit(WRITE_LIMIT)
  @Post('campaigns/:id/resume')
  resume(
    @CurrentAdvertiser() a: AdvertiserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.advertisers.setRunState(
      a.advertiserId,
      id,
      CampaignState.ACTIVE,
    );
  }

  @UseGuards(AdvertiserAuthGuard, RedisRateLimitGuard)
  @RateLimit(WRITE_LIMIT)
  @Post('campaigns/:id/end')
  end(
    @CurrentAdvertiser() a: AdvertiserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.advertisers.setRunState(
      a.advertiserId,
      id,
      CampaignState.ENDED,
    );
  }

  /** Body: `{ views: number }` → `{ checkoutUrl, txRef, amountMinor }`. */
  @UseGuards(AdvertiserAuthGuard, RedisRateLimitGuard)
  @RateLimit(WRITE_LIMIT)
  @Post('campaigns/:id/checkout')
  checkout(
    @CurrentAdvertiser() a: AdvertiserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body('views', ParseIntPipe) views: number,
  ) {
    return this.advertisers.checkout(a.advertiserId, id, views);
  }

  @UseGuards(AdvertiserAuthGuard)
  @Get('payments')
  payments(@CurrentAdvertiser() a: AdvertiserPrincipal) {
    return this.advertisers.listPayments(a.advertiserId);
  }

  /** Site calls this after Chapa redirects back with `?paid=<txRef>`. */
  @UseGuards(AdvertiserAuthGuard, RedisRateLimitGuard)
  @RateLimit(WRITE_LIMIT)
  @Post('payments/:txRef/verify')
  verify(@Param('txRef') txRef: string) {
    return this.advertisers.applyVerifiedPayment(txRef);
  }

  // ---- Chapa server-to-server

  @UseGuards(RedisRateLimitGuard)
  @RateLimit(RateLimitPresets.webhook)
  @Post('payments/chapa/webhook')
  async webhook(@Req() req: RawBodyRequest<Request>) {
    const raw = req.rawBody;
    if (!raw?.length) throw new BadRequestException('Missing raw request body');
    if (
      !this.chapa.verifyWebhookSignature(
        raw,
        req.headers as Record<string, unknown>,
      )
    ) {
      throw new BadRequestException('Invalid Chapa webhook signature');
    }
    const body = JSON.parse(raw.toString('utf8')) as {
      tx_ref?: string;
      trx_ref?: string;
    };
    const txRef = body.tx_ref ?? body.trx_ref;
    if (!txRef?.startsWith('a.')) {
      // Not an advertiser order (driver subscriptions use `s.`); ack quietly.
      return { ignored: true };
    }
    return this.advertisers.applyVerifiedPayment(txRef);
  }

  @UseGuards(RedisRateLimitGuard)
  @RateLimit(RateLimitPresets.webhook)
  @Get('payments/chapa/callback')
  callback(@Query('trx_ref') trxRef?: string, @Query('tx_ref') txRef?: string) {
    const ref = trxRef || txRef;
    if (!ref) throw new BadRequestException('Missing tx_ref');
    return this.advertisers.applyVerifiedPayment(ref);
  }
}
