import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * Prometheus metrics for SLOs:
 * - match p95 (histogram)
 * - HTTP errors
 * - seat oversell (=0 forever in correct operation)
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry = new Registry();

  readonly httpRequestDuration: Histogram<string>;
  readonly httpRequestsTotal: Counter<string>;
  readonly matchDuration: Histogram<string>;
  readonly seatConflictTotal: Counter<string>;
  readonly seatOversellTotal: Counter<string>;
  readonly dispatchJobsTotal: Counter<string>;

  constructor() {
    this.registry.setDefaultLabels({ service: 'api-core' });

    this.httpRequestDuration = new Histogram({
      name: 'hebir_http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status_code'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.4, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.httpRequestsTotal = new Counter({
      name: 'hebir_http_requests_total',
      help: 'Total HTTP requests',
      labelNames: ['method', 'route', 'status_code'] as const,
      registers: [this.registry],
    });

    this.matchDuration = new Histogram({
      name: 'hebir_match_duration_seconds',
      help: 'Share-match findMatches latency (SLO: p95 < 400ms)',
      labelNames: ['result'] as const,
      buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.4, 0.5, 1, 2, 5],
      registers: [this.registry],
    });

    this.seatConflictTotal = new Counter({
      name: 'hebir_booking_seat_conflict_total',
      help: 'Atomic seat decrement races lost (expected under contention)',
      registers: [this.registry],
    });

    this.seatOversellTotal = new Counter({
      name: 'hebir_seat_oversell_total',
      help: 'Successful oversells — must stay 0',
      registers: [this.registry],
    });

    this.dispatchJobsTotal = new Counter({
      name: 'hebir_dispatch_jobs_total',
      help: 'Dispatch queue jobs processed',
      labelNames: ['type', 'outcome'] as const,
      registers: [this.registry],
    });
  }

  onModuleInit() {
    if (process.env.METRICS_DEFAULTS !== 'false') {
      collectDefaultMetrics({ register: this.registry, prefix: 'hebir_' });
    }
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }

  contentType(): string {
    return this.registry.contentType;
  }
}
