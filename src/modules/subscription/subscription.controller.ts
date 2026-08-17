import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
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

@Controller('subscription')
export class SubscriptionController {
  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly config: ConfigService,
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
   * Verified against the exact bytes the provider signed. Hashing the parsed
   * DTO instead would only match by coincidence, because ValidationPipe
   * strips unknown fields and re-serialises in declaration order.
   */
  private verifySignature(
    rawBody: Buffer | undefined,
    signature: string,
  ) {
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
