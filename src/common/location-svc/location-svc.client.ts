import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as http from 'http';
import * as https from 'https';

type BreakerState = 'closed' | 'open' | 'half';

/**
 * Shared HTTP client for location-svc with keep-alive + simple circuit breaker.
 * Prevents api-core from stampeding a down Redis/geo service at 10k fleet scale.
 */
@Injectable()
export class LocationSvcClient implements OnModuleDestroy {
  private readonly logger = new Logger(LocationSvcClient.name);
  private readonly http: AxiosInstance;
  private readonly baseUrl: string;

  private state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private halfOpenProbeInFlight = false;

  private readonly failureThreshold: number;
  private readonly openMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = (config.get<string>('LOCATION_SVC_URL') ?? '').replace(
      /\/$/,
      '',
    );
    this.failureThreshold = Number(
      config.get<string>('LOCATION_SVC_BREAKER_FAILURES') ?? 5,
    );
    this.openMs = Number(
      config.get<string>('LOCATION_SVC_BREAKER_OPEN_MS') ?? 10_000,
    );

    const maxSockets = Number(
      config.get<string>('LOCATION_SVC_MAX_SOCKETS') ?? 100,
    );
    // Shared-token auth: location-svc requires this bearer token when its own
    // LOCATION_SVC_TOKEN env is set; when unset (local demo) it stays open.
    const token = config.get<string>('LOCATION_SVC_TOKEN');
    this.http = axios.create({
      timeout: Number(config.get<string>('LOCATION_SVC_TIMEOUT_MS') ?? 2000),
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      httpAgent: new http.Agent({
        keepAlive: true,
        maxSockets,
        maxFreeSockets: Math.min(20, maxSockets),
      }),
      httpsAgent: new https.Agent({
        keepAlive: true,
        maxSockets,
        maxFreeSockets: Math.min(20, maxSockets),
      }),
    });
  }

  onModuleDestroy() {
    const httpAgent = this.http.defaults.httpAgent as http.Agent | undefined;
    const httpsAgent = this.http.defaults.httpsAgent as https.Agent | undefined;
    httpAgent?.destroy?.();
    httpsAgent?.destroy?.();
  }

  get enabled() {
    return Boolean(this.baseUrl);
  }

  /** True when calls should be skipped (breaker open). */
  get isOpen() {
    this.maybeHalfOpen();
    return this.state === 'open';
  }

  async post<T = unknown>(path: string, body: unknown, timeoutMs?: number) {
    return this.request<T>('post', path, body, timeoutMs);
  }

  async get<T = unknown>(
    path: string,
    params?: Record<string, string | number>,
    timeoutMs?: number,
  ) {
    return this.request<T>('get', path, undefined, timeoutMs, params);
  }

  private maybeHalfOpen() {
    if (this.state === 'open' && Date.now() - this.openedAt >= this.openMs) {
      this.state = 'half';
    }
  }

  private recordSuccess() {
    this.failures = 0;
    this.state = 'closed';
  }

  private recordFailure(err: unknown) {
    this.failures += 1;
    if (this.failures >= this.failureThreshold || this.state === 'half') {
      this.state = 'open';
      this.openedAt = Date.now();
      this.logger.warn(
        `location-svc breaker OPEN after ${this.failures} failures: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private async request<T>(
    method: 'get' | 'post',
    path: string,
    body?: unknown,
    timeoutMs?: number,
    params?: Record<string, string | number>,
  ): Promise<T> {
    if (!this.baseUrl) {
      throw new Error('LOCATION_SVC_URL is not configured');
    }
    this.maybeHalfOpen();
    if (this.state === 'open') {
      throw new Error('location-svc circuit open');
    }
    // Half-open admits a single probe; everything else fails fast as if the
    // breaker were still open, so a recovering service is not stampeded.
    const isProbe = this.state === 'half';
    if (isProbe && this.halfOpenProbeInFlight) {
      throw new Error('location-svc circuit open');
    }
    if (isProbe) {
      this.halfOpenProbeInFlight = true;
    }

    try {
      const { data } = await this.http.request<T>({
        method,
        url: `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`,
        data: body,
        params,
        timeout: timeoutMs,
      });
      this.recordSuccess();
      return data;
    } catch (err) {
      this.recordFailure(err);
      throw err;
    } finally {
      if (isProbe) {
        this.halfOpenProbeInFlight = false;
      }
    }
  }
}
