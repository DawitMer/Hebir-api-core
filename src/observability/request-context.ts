import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';

export type RequestContextStore = {
  requestId: string;
  traceId?: string;
  spanId?: string;
};

export const requestContext = new AsyncLocalStorage<RequestContextStore>();

export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

export function resolveOrCreateRequestId(headerValue: string | string[] | undefined): string {
  if (typeof headerValue === 'string' && headerValue.trim()) {
    return headerValue.trim().slice(0, 128);
  }
  if (Array.isArray(headerValue) && headerValue[0]) {
    return String(headerValue[0]).trim().slice(0, 128);
  }
  return randomUUID();
}

/** Parse W3C traceparent: version-traceid-spanid-flags */
export function parseTraceparent(header: string | undefined): {
  traceId?: string;
  spanId?: string;
} {
  if (!header) return {};
  const parts = header.trim().split('-');
  if (parts.length < 4) return {};
  return { traceId: parts[1], spanId: parts[2] };
}
