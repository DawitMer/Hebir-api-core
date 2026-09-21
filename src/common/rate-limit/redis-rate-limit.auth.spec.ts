import { phoneFromAuthBody, signInBuckets } from './redis-rate-limit.guard';

describe('sign-in rate limit buckets', () => {
  it('gives each phone its own budget so two portals do not share one counter', () => {
    const ops = signInBuckets({
      prefix: 'rl:auth',
      identity: '203.0.113.8',
      phone: '+251911000001',
      limit: 10,
    });
    const gov = signInBuckets({
      prefix: 'rl:auth',
      identity: '203.0.113.8',
      phone: '+251911000002',
      limit: 10,
    });

    expect(ops[0]?.key).toBe('rl:auth:phone:+251911000001');
    expect(gov[0]?.key).toBe('rl:auth:phone:+251911000002');
    expect(ops[0]?.key).not.toBe(gov[0]?.key);
    expect(ops[0]?.limit).toBe(10);
    expect(gov[0]?.limit).toBe(10);
    expect(ops[1]?.key).toBe(gov[1]?.key);
    expect(ops[1]?.limit).toBeGreaterThanOrEqual(60);
  });

  it('keeps non-phone auth calls on the network identity', () => {
    expect(
      signInBuckets({
        prefix: 'rl:auth',
        identity: '203.0.113.8',
        limit: 10,
      }),
    ).toEqual([{ key: 'rl:auth:203.0.113.8', limit: 10 }]);
  });

  it('reads a phone number from the sign-in body', () => {
    expect(phoneFromAuthBody({ phoneNumber: ' +251911000002 ' })).toBe(
      '+251911000002',
    );
    expect(phoneFromAuthBody({ phoneNumber: 'not-a-phone' })).toBeUndefined();
    expect(phoneFromAuthBody(null)).toBeUndefined();
  });
});
