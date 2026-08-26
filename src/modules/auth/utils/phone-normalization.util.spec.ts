import {
  isValidEthiopianPhoneNumber,
  normalizePhoneNumber,
} from './phone-normalization.util';

describe('PhoneNormalizationUtil', () => {
  describe('normalizePhoneNumber', () => {
    it('normalizes local 10-digit Ethiopian numbers starting with 09', () => {
      expect(normalizePhoneNumber('0911223344')).toBe('+251911223344');
      expect(normalizePhoneNumber('0912345678')).toBe('+251912345678');
    });

    it('normalizes local 10-digit Ethiopian numbers starting with 07 (Safaricom)', () => {
      expect(normalizePhoneNumber('0711223344')).toBe('+251711223344');
    });

    it('normalizes 9-digit Ethiopian numbers without leading 0', () => {
      expect(normalizePhoneNumber('911223344')).toBe('+251911223344');
      expect(normalizePhoneNumber('711223344')).toBe('+251711223344');
    });

    it('normalizes 12-digit Ethiopian numbers starting with 251', () => {
      expect(normalizePhoneNumber('251911223344')).toBe('+251911223344');
      expect(normalizePhoneNumber('251711223344')).toBe('+251711223344');
    });

    it('retains valid E.164 Ethiopian numbers with +251', () => {
      expect(normalizePhoneNumber('+251911223344')).toBe('+251911223344');
    });

    it('strips spaces, dashes, and parentheses', () => {
      expect(normalizePhoneNumber('0911 22 33 44')).toBe('+251911223344');
      expect(normalizePhoneNumber('(0911) 22-33-44')).toBe('+251911223344');
      expect(normalizePhoneNumber('+251-911-22-33-44')).toBe('+251911223344');
    });

    it('handles valid international numbers with plus', () => {
      expect(normalizePhoneNumber('+12025550123')).toBe('+12025550123');
      expect(normalizePhoneNumber('+447911123456')).toBe('+447911123456');
    });

    it('throws on empty or invalid inputs', () => {
      expect(() => normalizePhoneNumber('')).toThrow();
      expect(() => normalizePhoneNumber('123')).toThrow();
      expect(() => normalizePhoneNumber('not-a-number')).toThrow();
    });
  });

  describe('isValidEthiopianPhoneNumber', () => {
    it('returns true for valid Ethiopian numbers', () => {
      expect(isValidEthiopianPhoneNumber('0911223344')).toBe(true);
      expect(isValidEthiopianPhoneNumber('0712345678')).toBe(true);
      expect(isValidEthiopianPhoneNumber('+251911223344')).toBe(true);
    });

    it('returns false for foreign or invalid numbers', () => {
      expect(isValidEthiopianPhoneNumber('+12025550123')).toBe(false);
      expect(isValidEthiopianPhoneNumber('0111223344')).toBe(false); // Landline
      expect(isValidEthiopianPhoneNumber('invalid')).toBe(false);
    });
  });
});
