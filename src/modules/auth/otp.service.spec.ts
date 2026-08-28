import { ConfigService } from '@nestjs/config';
import { HttpException, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
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
      setex: jest.fn(async (key: string, ttl: number, val: string) => {
        redis.store.set(key, { value: val, expiresAt: Date.now() + ttl * 1000 });
      }),
      del: jest.fn(async (key: string) => {
        redis.store.delete(key);
      }),
      incr: jest.fn(async (key: string) => {
        const current = Number(redis.store.get(key)?.value ?? '0') + 1;
        redis.store.set(key, {
          value: String(current),
          expiresAt: Date.now() + 3600 * 1000,
        });
        return current;
      }),
      expire: jest.fn(),
      ttl: jest.fn(async (key: string) => {
        const row = redis.store.get(key);
        if (!row) return -2;
        const rem = Math.ceil((row.expiresAt - Date.now()) / 1000);
        return rem > 0 ? rem : -2;
      }),
    };
    sms = { sendOtp: jest.fn().mockResolvedValue(undefined) };
    service = new OtpService(
      redis as never,
      configOf({
        NODE_ENV: 'production',
        SMS_PROVIDER: 'geezsms',
        GEEZSMS_TOKEN: 'mock-token',
        JWT_ACCESS_SECRET: 'test-pepper',
      }),
      sms as unknown as SmsService,
    );
  });

  it('refuses to send in production when no SMS provider is configured', async () => {
    const noSms = new OtpService(
      redis as never,
      configOf({ NODE_ENV: 'production', JWT_ACCESS_SECRET: 'test-pepper' }),
      sms as unknown as SmsService,
    );
    await expect(noSms.request(phone)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('enforces per-phone resend cooldown', async () => {
    await redis.setex(`otp:cooldown:${phone}`, 25, '1');
    await expect(service.request(phone)).rejects.toThrow(
      HttpException,
    );
  });

  it('enforces per-phone hourly request cap', async () => {
    redis.incr.mockResolvedValueOnce(6);
    await expect(service.request(phone)).rejects.toThrow(
      HttpException,
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
    const prod = new OtpService(
      redis as never,
      configOf({ NODE_ENV: 'production', JWT_ACCESS_SECRET: 'test-pepper' }),
      sms as unknown as SmsService,
    );
    const code = '654321';
    const hash = (prod as unknown as { hash: (p: string, c: string) => string }).hash(phone, code);
    await redis.setex(`otp:phone:${phone}`, 300, hash);
    await prod.consumeCode(phone, code);
    await expect(prod.consumeCode(phone, code)).rejects.toThrow(
      'Invalid or expired OTP',
    );
  });
});
