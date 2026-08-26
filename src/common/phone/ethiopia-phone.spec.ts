import {
  normalizeEthiopiaE164,
  toEthiopiaBareMsisdn,
  toEthiopiaNational10,
} from './ethiopia-phone';

describe('normalizeEthiopiaE164', () => {
  it('normalizes local 09XXXXXXXX to +2519XXXXXXXX', () => {
    expect(normalizeEthiopiaE164('0911234567')).toBe('+251911234567');
  });

  it('accepts 9XXXXXXXX without the trunk 0', () => {
    expect(normalizeEthiopiaE164('911234567')).toBe('+251911234567');
  });

  it('accepts already-international forms', () => {
    expect(normalizeEthiopiaE164('+251911234567')).toBe('+251911234567');
    expect(normalizeEthiopiaE164('251911234567')).toBe('+251911234567');
    expect(normalizeEthiopiaE164('+251 911 234 567')).toBe('+251911234567');
  });

  it('rejects incomplete numbers', () => {
    expect(normalizeEthiopiaE164('09112')).toBeNull();
    expect(normalizeEthiopiaE164('')).toBeNull();
    expect(normalizeEthiopiaE164(null)).toBeNull();
  });

  it('rejects 9-digit numbers that are not Ethiopian mobiles (7/9)', () => {
    expect(normalizeEthiopiaE164('111234567')).toBeNull();
    expect(normalizeEthiopiaE164('0111234567')).toBeNull();
  });

  it('accepts Safaricom Ethiopia 07XXXXXXXX', () => {
    expect(normalizeEthiopiaE164('0711234567')).toBe('+251711234567');
  });

  it('exposes gateway-specific national forms', () => {
    expect(toEthiopiaBareMsisdn('+251911234567')).toBe('251911234567');
    expect(toEthiopiaNational10('+251911234567')).toBe('0911234567');
  });
});
