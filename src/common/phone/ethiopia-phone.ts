import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { Matches } from 'class-validator';

/** Ethiopian mobile in E.164: +251 + 9 national digits starting 7 or 9. */
export const ETHIOPIA_E164 = /^\+251[79]\d{8}$/;

/**
 * Normalize user-entered Ethiopian numbers to E.164.
 * Accepts 09XXXXXXXX, 9XXXXXXXX, 07XXXXXXXX, 2519XXXXXXXX, +251 9XX XXX XXX.
 * Returns null when the input cannot be a 9-digit national mobile (7/9).
 */
export function normalizeEthiopiaE164(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('+') && !trimmed.startsWith('+251')) {
    return null;
  }
  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('251') && digits.length >= 12) {
    digits = digits.slice(3);
  }
  if (digits.startsWith('0') && digits.length >= 10) {
    digits = digits.slice(1);
  }
  if (digits.length === 12 && digits.startsWith('251')) {
    digits = digits.slice(3);
  }
  if (!/^[79]\d{8}$/.test(digits)) return null;
  return `+251${digits}`;
}

/** `2519XXXXXXXX` — GeezSMS and similar local gateways. */
export function toEthiopiaBareMsisdn(e164: string): string | null {
  const normalized = normalizeEthiopiaE164(e164);
  return normalized ? normalized.slice(1) : null;
}

/** `09XXXXXXXX` / `07XXXXXXXX` — Chapa phone_number field. */
export function toEthiopiaNational10(e164: string): string | null {
  const normalized = normalizeEthiopiaE164(e164);
  return normalized ? `0${normalized.slice(4)}` : null;
}

export function IsEthiopiaPhone(
  message = 'phoneNumber must be a valid Ethiopian mobile (+2517XXXXXXXX or +2519XXXXXXXX)',
) {
  return applyDecorators(
    Transform(({ value }) =>
      typeof value === 'string'
        ? (normalizeEthiopiaE164(value) ?? value.trim())
        : value,
    ),
    Matches(ETHIOPIA_E164, { message }),
  );
}
