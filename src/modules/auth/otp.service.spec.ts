import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException, TooManyRequestsException } from '@nestjs/common';
import { OtpService } from './otp.service';
import { SmsService } from './sms.service';

function configOf(map: Record<string, string>): ConfigService {
  return { get: (key: string) => map[key] } as ConfigService;
}

describe('OtpService', () => {
  const phone = '+251911223344';
  let redis: {
    store: Map<string, { value: string; expiresAt: number }>;
    get: jest.Mock;
    setex: jest.Mock;
    del: jest.Mock;
    incr: jest.Mock;
    expire: jest.Mock;
    ttl: jest.Mock;
  };
  let sms: { sendOtp: jest.Mock };
  let service: OtpService;

  beforeEach(() => {
    redis = {
      store: new Map(),
      get: jest.fn(async (key: string) => {
        const row = redis.store.get(key);
        if (!row || row.expiresAt <= Date.now()) return null;
        return row.value;
      }),
      setex: jest.fn(async (key: string, ttl: number, value: string) => {
        redis.store.set(key, {
          value,
          expiresAt: Date.now() + ttl * 1000,
        });
      }),
      del: jest.fn(async (...keys: string[]) => {
        for (const key of keys) redis.store.delete(key);
        return keys.length;
      }),
      incr: jest.fn(async (key: string) => {
        const current = Number(redis.store.get(key)?.value ?? 0) + 1;
        redis.store.set(key, {
          value: String(current),
          expiresAt: Date.now() + 3600_000,
        });
        return current;
      }),
      expire: jest.fn(async () => 1),
      ttl: jest.fn(async (key: string) => {
        const row = redis.store.get(key);
        if (!row) return -2;
        const remaining = Math.ceil((row.expiresAt - Date.now()) / 1000);
        return remaining > 0 ? remaining : -2;
      }),
    };

    sms = { sendOtp: jest.fn(async () => undefined) };

    service = new OtpService(
      redis as never,
      configOf({
        NODE_ENV: 'production',
        SMS_PROVIDER: 'afromessage',
        JWT_ACCESS_SECRET: 'test-pepper',
      }),
      sms as unknown as SmsService,
    );
  });

  it('refuses production OTP when SMS_PROVIDER is missing', async () => {
    const prod = new OtpService(
      redis as never,
      configOf({ NODE_ENV: 'production' }),
      sms as unknown as SmsService,
    );
    await expect(prod.request(phone)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('enforces per-phone resend cooldown', async () => {
    await redis.setex(`otp:cooldown:${phone}`, 25, '1');
    await expect(service.request(phone)).rejects.toBeInstanceOf(
      TooManyRequestsException,
    );
  });

  it('enforces per-phone hourly request cap', async () => {
    redis.incr.mockResolvedValueOnce(6);
    await expect(service.request(phone)).rejects.toBeInstanceOf(
      TooManyRequestsException,
    );
  });

  it('returns immediately in production without awaiting SMS', async () => {
    let resolveSms!: () => void;
    sms.sendOtp.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSms = resolve;
        }),
    );

    const pending = service.request(phone);
    await expect(pending).resolves.toEqual({
      sent: true,
      expiresInSec: 300,
    });
    expect(sms.sendOtp).toHaveBeenCalledTimes(1);

    resolveSms();
    await new Promise((r) => setImmediate(r));
    expect(await redis.ttl(`otp:cooldown:${phone}`)).toBeGreaterThan(0);
  });

  it('burns OTP after successful verify and rejects reuse', async () => {
    const dev = new OtpService(
      redis as never,
      configOf({ NODE_ENV: 'development', JWT_ACCESS_SECRET: 'test-pepper' }),
      sms as unknown as SmsService,
    );
    await dev.request(phone);
    await dev.consumeCode(phone, '123456');
    await expect(dev.consumeCode(phone, '123456')).rejects.toThrow(
      'Invalid or expired OTP',
    );
  });
});
