import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { SmsService } from './sms.service';

function configOf(map: Record<string, string>): ConfigService {
  return { get: (key: string) => map[key] } as ConfigService;
}

describe('SmsService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('posts to AfroMessage and requires acknowledge=success', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ acknowledge: 'success' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const sms = new SmsService(
      configOf({
        SMS_PROVIDER: 'afromessage',
        AFROMESSAGE_TOKEN: 'tok',
        AFROMESSAGE_SENDER: 'Hebir',
      }),
    );
    await sms.sendOtp('+251911223344', '123456');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.afromessage.com/api/send');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok',
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      to: '+251911223344',
      sender: 'Hebir',
    });
  });

  it('refuses AfroMessage when the gateway returns acknowledge=error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ acknowledge: 'error' }),
    }) as unknown as typeof fetch;

    const sms = new SmsService(
      configOf({ SMS_PROVIDER: 'afromessage', AFROMESSAGE_TOKEN: 'tok' }),
    );
    await expect(sms.sendOtp('+251911223344', '123456')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('sends GeezSMS with a bare 251 MSISDN', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({}) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const sms = new SmsService(
      configOf({ SMS_PROVIDER: 'geezsms', GEEZSMS_TOKEN: 'g-tok' }),
    );
    await sms.sendOtp('+251911223344', '123456');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.geezsms.com/api/v1/sms/send');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('phone')).toBe('251911223344');
    expect(body.get('token')).toBe('g-tok');
  });
});
