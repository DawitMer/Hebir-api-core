import 'reflect-metadata';
import { validate } from './env.validation';

function prodBase(): Record<string, unknown> {
  return {
    NODE_ENV: 'production',
    PORT: '3000',
    DATABASE_URL: 'postgresql://hebir:hebir@db/hebir',
    REDIS_URL: 'rediss://default:secret@redis.example:6379',
    JWT_ACCESS_SECRET: 'abcdefghijklmnopqrstuvwx',
    JWT_ACCESS_EXPIRES_IN: '15m',
    JWT_REFRESH_SECRET: 'abcdefghijklmnopqrstuvwx',
    JWT_REFRESH_EXPIRES_IN: '30d',
    LOCATION_SVC_URL: 'http://location-svc:8090',
    LOCATION_SVC_TOKEN: 'location-svc-token',
    PAYMENT_WEBHOOK_SECRET: 'abcdefghijklmnopqrstuvwx',
    CORS_ORIGINS: 'https://ops.hebir.et',
    METRICS_TOKEN: 'metrics-token-16',
    SMS_PROVIDER: 'http',
    SMS_HTTP_URL: 'https://sms.example/send',
  };
}

describe('production env gates', () => {
  it('starts when SMS, Redis, CORS, and tokens are set', () => {
    expect(() => validate(prodBase())).not.toThrow();
  });

  it('refuses production without an SMS provider', () => {
    const env = prodBase();
    delete env.SMS_PROVIDER;
    delete env.SMS_HTTP_URL;
    expect(() => validate(env)).toThrow(/SMS_PROVIDER/);
  });

  it('starts with AfroMessage credentials', () => {
    const env = prodBase();
    delete env.SMS_HTTP_URL;
    env.SMS_PROVIDER = 'afromessage';
    env.AFROMESSAGE_TOKEN = 'afro-token';
    expect(() => validate(env)).not.toThrow();
  });

  it('refuses AfroMessage without a token', () => {
    const env = prodBase();
    env.SMS_PROVIDER = 'afromessage';
    expect(() => validate(env)).toThrow(/AFROMESSAGE_TOKEN/);
  });

  it('refuses production Redis on loopback without REDIS_URL', () => {
    const env = prodBase();
    delete env.REDIS_URL;
    env.REDIS_HOST = '127.0.0.1';
    env.REDIS_PORT = '6379';
    expect(() => validate(env)).toThrow(/REDIS_URL/);
  });
});
