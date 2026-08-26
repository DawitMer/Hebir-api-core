import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { Request, Response } from 'express';
import { MetricsService } from './metrics.service';
import {
  parseTraceparent,
  requestContext,
  resolveOrCreateRequestId,
} from './request-context';

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const requestId = resolveOrCreateRequestId(
      req.headers['x-request-id'] ?? req.headers['x-correlation-id'],
    );
    res.setHeader('x-request-id', requestId);

    const { traceId, spanId } = parseTraceparent(
      typeof req.headers.traceparent === 'string'
        ? req.headers.traceparent
        : undefined,
    );

    const started = process.hrtime.bigint();
    const route =
      (req.route?.path as string | undefined) || req.path || 'unknown';

    return requestContext.run({ requestId, traceId, spanId }, () =>
      next.handle().pipe(
        finalize(() => {
          this.observe(req.method, route, res.statusCode || 200, started);
        }),
      ),
    );
  }

  private observe(
    method: string,
    route: string,
    statusCode: number,
    started: bigint,
  ) {
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    const labels = {
      method: method.toUpperCase(),
      route,
      status_code: String(statusCode),
    };
    this.metrics.httpRequestDuration.observe(labels, seconds);
    this.metrics.httpRequestsTotal.inc(labels);
  }
}
