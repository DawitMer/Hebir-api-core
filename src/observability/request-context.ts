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

export function resolveOrCreateRequestId(
  headerValue: string | string[] | undefined,
): string {
  const candidate = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)) return candidate;
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
