import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  Logger,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Response } from 'express';
import { MetricsService } from './metrics.service';

@Controller()
export class MetricsController {
  private readonly logger = new Logger(MetricsController.name);
  private readonly scrapeToken: string;

  constructor(
    private readonly metricsService: MetricsService,
    config: ConfigService,
  ) {
    this.scrapeToken = config.get<string>('METRICS_TOKEN') ?? '';
    if (!this.scrapeToken && config.get<string>('NODE_ENV') === 'production') {
      throw new Error('METRICS_TOKEN is required in production');
    }
  }

  /**
   * Prometheus scrape endpoint. It enumerates every route, request volume and
   * dispatch counter, so when METRICS_TOKEN is configured the scraper must
   * present it as a bearer token.
   */
  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  async scrape(
    @Res() res: Response,
    @Headers('authorization') authorization?: string,
  ) {
    if (!this.scrapeToken || !this.hasValidToken(authorization)) {
      throw new ForbiddenException('Invalid metrics token');
    }
    res.setHeader('Content-Type', this.metricsService.contentType());
    res.send(await this.metricsService.render());
  }

  private hasValidToken(authorization?: string): boolean {
    const provided = (authorization ?? '').replace(/^Bearer /i, '');
    const a = Buffer.from(provided);
    const b = Buffer.from(this.scrapeToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}
