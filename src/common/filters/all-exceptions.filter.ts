import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';

/**
 * Production errors must not leak SQL, stack traces, or driver messages.
 * HttpException payloads (validation, 403, 409) stay intact.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();
    if (!res || typeof res.status !== 'function' || res.headersSent) {
      return;
    }

    const requestId = resolveRequestId(req);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      this.log(status, req, exception);
      if (typeof body === 'string') {
        res
          .status(status)
          .json({ statusCode: status, message: body, requestId });
        return;
      }
      res.status(status).json({
        ...(typeof body === 'object' && body ? body : {}),
        statusCode: status,
        requestId,
      });
      return;
    }

    const mapped = mapInfrastructureError(exception);
    this.log(mapped.status, req, exception);
    res.status(mapped.status).json({
      statusCode: mapped.status,
      message: mapped.message,
      requestId,
    });
  }

  private log(status: number, req: Request, exception: unknown) {
    const err =
      exception instanceof Error ? exception : new Error(String(exception));
    const line = `${req.method ?? '?'} ${req.url ?? '?'} ${status}: ${err.message}`;
    if (status >= 500) {
      this.logger.error(line, err.stack);
    } else {
      this.logger.warn(line);
    }
  }
}

export function mapInfrastructureError(exception: unknown): {
  status: number;
  message: string;
} {
  if (exception instanceof QueryFailedError) {
    const code = (exception.driverError as { code?: string } | undefined)?.code;
    if (code === '23505') {
      return {
        status: HttpStatus.CONFLICT,
        message: 'This record already exists',
      };
    }
    if (code === '23503' || code === '23514' || code === '22P02') {
      return { status: HttpStatus.BAD_REQUEST, message: 'Invalid request' };
    }
  }
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    message: 'Internal server error',
  };
}

function resolveRequestId(req: Request & { id?: string }): string | undefined {
  if (typeof req.id === 'string' && req.id) return req.id;
  const header = req.headers?.['x-request-id'];
  return typeof header === 'string' && header.trim()
    ? header.trim()
    : undefined;
}
