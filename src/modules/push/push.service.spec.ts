import { ConfigService } from '@nestjs/config';
import { PushService, WS_PRESENCE_KEY_PREFIX } from './push.service';

// A throwaway RSA key so googleAccessToken can sign a JWT offline.
import { generateKeyPairSync } from 'crypto';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = {
  project_id: 'test-project',
  client_email: 'fcm@test-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

type FetchCall = { url: string; body: any };

function mockFetch(
  handler: (call: FetchCall) => { status: number; body?: unknown },
) {
  const calls: FetchCall[] = [];
  const impl = jest.fn(async (url: string, init?: RequestInit) => {
    const call = {
      url: String(url),
      body: init?.body ? safeParse(init.body) : undefined,
    };
    calls.push(call);
    const result = handler(call);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.body ?? {},
      text: async () =>
        typeof result.body === 'string'
          ? result.body
          : JSON.stringify(result.body ?? {}),
    } as unknown as Response;
  });
  return { impl, calls };
}

function safeParse(body: BodyInit): unknown {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  return body instanceof URLSearchParams ? body.toString() : body;
}

function build(opts: {
  devices: Array<{ id: string; token: string; platform: string }>;
  liveSockets?: number;
}) {
  const deleted: string[] = [];
  const tokens = {
    find: jest.fn().mockResolvedValue(opts.devices),
    delete: jest.fn(async (where: { id: string }) => {
      deleted.push(where.id);
    }),
    upsert: jest.fn().mockResolvedValue(undefined),
  };
  const redis = {
    scard: jest.fn().mockResolvedValue(opts.liveSockets ?? 0),
  };
  const service = new PushService(
    new ConfigService({
      FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount),
    }),
    tokens as never,
    redis as never,
  );
  return { service, tokens, redis, deleted };
}

describe('PushService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('skips non-critical events while the user has a live socket', async () => {
    const { service, tokens, redis } = build({
      devices: [{ id: 'd1', token: 't1', platform: 'android' }],
      liveSockets: 1,
    });
    const { impl } = mockFetch(() => ({ status: 200 }));
    global.fetch = impl as never;

    await service.notifyEvent('user-1', 'ride.chat_message', { rideId: 'r1' });

    expect(redis.scard).toHaveBeenCalledWith(`${WS_PRESENCE_KEY_PREFIX}user-1`);
    expect(tokens.find).not.toHaveBeenCalled();
    expect(impl).not.toHaveBeenCalled();
  });

  it('always pushes an offer, even with a live socket, on the offers channel', async () => {
    const { service } = build({
      devices: [{ id: 'd1', token: 't1', platform: 'android' }],
      liveSockets: 1,
    });
    const { impl, calls } = mockFetch((call) =>
      call.url.includes('oauth2')
        ? { status: 200, body: { access_token: 'at', expires_in: 3600 } }
        : { status: 200, body: { name: 'projects/x/messages/1' } },
    );
    global.fetch = impl as never;

    await service.notifyEvent('user-1', 'ride.offer', {
      rideId: 'r1',
      pickupAddress: 'Piassa',
    });

    const send = calls.find((c) => c.url.includes('messages:send'));
    expect(send).toBeDefined();
    expect(send!.url).toContain('/projects/test-project/messages:send');
    expect(send!.body.message.token).toBe('t1');
    expect(send!.body.message.android.notification.channel_id).toBe(
      'ridehebir_ride_offers_v4',
    );
    expect(send!.body.message.data).toMatchObject({
      event: 'ride.offer',
      rideId: 'r1',
      route: 'offer',
    });
  });

  it('deletes dead tokens and retries transient failures once', async () => {
    const { service, deleted } = build({
      devices: [
        { id: 'dead', token: 'gone', platform: 'android' },
        { id: 'flaky', token: 'ok', platform: 'ios' },
      ],
    });
    let flakyAttempts = 0;
    const { impl } = mockFetch((call) => {
      if (call.url.includes('oauth2')) {
        return { status: 200, body: { access_token: 'at', expires_in: 3600 } };
      }
      if (call.body.message.token === 'gone') {
        return {
          status: 404,
          body: { error: { details: [{ errorCode: 'UNREGISTERED' }] } },
        };
      }
      flakyAttempts += 1;
      return flakyAttempts === 1 ? { status: 503 } : { status: 200 };
    });
    global.fetch = impl as never;

    await service.notifyEvent('user-1', 'ride.cancelled', { rideId: 'r1' });

    expect(deleted).toEqual(['dead']);
    expect(flakyAttempts).toBe(2);
  });

  it('does nothing when FCM is not configured', async () => {
    const tokens = { find: jest.fn() };
    const service = new PushService(
      new ConfigService({}),
      tokens as never,
      { scard: jest.fn().mockResolvedValue(0) } as never,
    );
    const { impl } = mockFetch(() => ({ status: 200 }));
    global.fetch = impl as never;

    expect(service.isConfigured()).toBe(false);
    await service.notifyEvent('user-1', 'ride.offer', {});
    expect(tokens.find).not.toHaveBeenCalled();
    expect(impl).not.toHaveBeenCalled();
  });
});
