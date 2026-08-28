/**
 * Canonical phone normalization utility for Hebir.
 *
 * Ethiopian mobiles are normalized via `ethiopia-phone.ts` (E.164 +251…).
 * International numbers are accepted only for staff/legacy paths that explicitly
 * need them — rider/driver auth DTOs use `@IsEthiopiaPhone()` instead.
 */

import { normalizeEthiopiaE164 } from '../../../common/phone/ethiopia-phone';

export function normalizePhoneNumber(raw: string): string {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Phone number must be a non-empty string');
  }

  const ethiopian = normalizeEthiopiaE164(raw);
  if (ethiopian) {
    return ethiopian;
  }

  // Remove all whitespace, dashes, parens, dots
  let cleaned = raw.replace(/[\s\-\(\)\.]/g, '').trim();

  // If someone types the international exit code 00, treat it as +
  if (cleaned.startsWith('00')) {
    cleaned = '+' + cleaned.slice(2);
  }

  // If starts with +, inspect following digits
  if (cleaned.startsWith('+')) {
    const digitsOnly = cleaned.slice(1);
    if (!/^\d{7,15}$/.test(digitsOnly)) {
      throw new Error(`Invalid international phone number: ${raw}`);
    }
    return `+${digitsOnly}`;
  }

  // International standard format without plus (e.g. 12025550123)
  if (/^\d{10,15}$/.test(cleaned)) {
    return `+${cleaned}`;
  }

  throw new Error(`Unrecognized phone number format: ${raw}`);
}

export function isValidEthiopianPhoneNumber(phone: string): boolean {
  try {
    const normalized = normalizePhoneNumber(phone);
    return /^\+251[79]\d{8}$/.test(normalized);
  } catch {
    return false;
  }
}
