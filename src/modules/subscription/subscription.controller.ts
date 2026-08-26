import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  RawBodyRequest,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import { SubscriptionService } from './subscription.service';
import { PaymentWebhookDto } from './dto/payment-webhook.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RedisRateLimitGuard } from '../../common/rate-limit/redis-rate-limit.guard';
import {
  RateLimit,
  RateLimitPresets,
} from '../../common/rate-limit/rate-limit.decorator';
import { ChapaClient } from '../payments/chapa.client';

@Controller('subscription')
export class SubscriptionController {
  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly config: ConfigService,
    private readonly chapa: ChapaClient,
  ) {}

  /**
   * Reachable without a user session (blueprint section 15), so it is
   * verified by signature instead, and rate-limited per IP.
   */
  @UseGuards(RedisRateLimitGuard)
  @RateLimit(RateLimitPresets.webhook)
  @Post('webhook')
  async webhook(
    @Body() dto: PaymentWebhookDto,
    @Headers('x-webhook-signature') signature: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    this.verifySignature(req.rawBody, signature);
    return this.subscriptionService.handleConfirmedPayment(dto);
  }

  /**
   * Chapa dashboard webhook. Signature is checked, then the charge is
   * re-fetched from Chapa so a forged body cannot activate a plan.
   */
  @UseGuards(RedisRateLimitGuard)
  @RateLimit(RateLimitPresets.webhook)
  @Post('webhook/chapa')
  async chapaWebhook(@Req() req: RawBodyRequest<Request>) {
    const raw = req.rawBody;
    if (!raw?.length) {
      throw new BadRequestException('Missing raw request body');
    }
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
      event?: string;
    };
    const txRef = body.tx_ref ?? body.trx_ref;
    if (!txRef) {
      throw new BadRequestException('Missing tx_ref');
    }
    return this.subscriptionService.applyVerifiedChapaCharge(txRef);
  }

  /** Chapa GET callback after checkout. Re-verifies before activating. */
  @UseGuards(RedisRateLimitGuard)
  @RateLimit(RateLimitPresets.webhook)
  @Get('chapa/callback')
  async chapaCallback(
    @Query('trx_ref') trxRef?: string,
    @Query('tx_ref') txRef?: string,
  ) {
    const ref = trxRef || txRef;
    if (!ref) {
      throw new BadRequestException('Missing tx_ref');
    }
    return this.subscriptionService.applyVerifiedChapaCharge(ref);
  }

  @Get('chapa/return')
  chapaReturn(@Res() res: Response) {
    res
      .type('text/plain')
      .send('Payment submitted. Return to the Hebir Driver app.');
  }

  @UseGuards(JwtAuthGuard)
  @Post('checkout')
  checkout(@CurrentUser() user: { userId: string }) {
    return this.subscriptionService.createChapaCheckout(user.userId);
  }

  /**
   * Verified against the exact bytes the provider signed. Hashing the parsed
   * DTO instead would only match by coincidence, because ValidationPipe
   * strips unknown fields and re-serialises in declaration order.
   */
  private verifySignature(rawBody: Buffer | undefined, signature: string) {
    const secret = this.config.get<string>('PAYMENT_WEBHOOK_SECRET');
    if (!rawBody?.length) {
      throw new BadRequestException(
        'Missing raw request body for signature verification',
      );
    }
    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    if (!signature || !this.matchesSignature(signature, expected)) {
      throw new BadRequestException('Invalid webhook signature');
    }
  }

  private matchesSignature(provided: string, expected: string): boolean {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    // Length is compared first because timingSafeEqual throws on a mismatch;
    // the digest length is not secret.
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  @UseGuards(JwtAuthGuard)
  @Get('status')
  status(@CurrentUser() user: { userId: string }) {
    return this.subscriptionService.getStatus(user.userId);
  }

  /** Local/demo only — skipped when NODE_ENV=production. */
  @UseGuards(JwtAuthGuard)
  @Post('dev-activate')
  async devActivate(@CurrentUser() user: { userId: string }) {
    if (this.config.get<string>('NODE_ENV') === 'production') {
      throw new BadRequestException('dev-activate disabled in production');
    }
    return this.subscriptionService.devActivate(user.userId);
  }
}
