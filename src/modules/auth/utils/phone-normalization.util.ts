/**
 * Canonical phone normalization utility for Hebir.
 *
 * Enforces E.164 format (+251...) across Ethiopia and supports international formats.
 */

export function normalizePhoneNumber(raw: string): string {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Phone number must be a non-empty string');
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

  // Handle 09... or 07... (local Ethiopian 10-digit mobile)
  if (/^0[79]\d{8}$/.test(cleaned)) {
    return `+251${cleaned.slice(1)}`;
  }

  // Handle 9... or 7... (Ethiopian 9-digit without leading 0)
  if (/^[79]\d{8}$/.test(cleaned)) {
    return `+251${cleaned}`;
  }

  // Handle 2519... or 2517... (12-digit Ethiopian without +)
  if (/^251[79]\d{8}$/.test(cleaned)) {
    return `+${cleaned}`;
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
