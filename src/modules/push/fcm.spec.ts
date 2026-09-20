import { ConfigService } from '@nestjs/config';
import {
  ANDROID_CHANNEL_OFFERS,
  ANDROID_CHANNEL_TRIP,
  buildFcmMessage,
  classifyFcmFailure,
  flattenPushData,
  loadFcmServiceAccount,
  pushCopyForEvent,
  pushPolicyForEvent,
  routeForEvent,
} from './fcm';

describe('pushCopyForEvent', () => {
  it('does not push live GPS pings or read receipts', () => {
    expect(pushCopyForEvent('ride.driver_location', { lat: 9 })).toBeNull();
    expect(pushCopyForEvent('ride.chat_read', {})).toBeNull();
    expect(pushPolicyForEvent('ride.driver_location', {})).toBeNull();
  });

  it('maps an incoming offer with the pickup label', () => {
    const copy = pushCopyForEvent('ride.offer', {
      pickupAddress: 'Bole Medhanealem',
    });
    expect(copy?.title).toBe('Incoming trip request');
    expect(copy?.body).toContain('Bole Medhanealem');
  });

  it('turns rider status changes into human copy', () => {
    expect(
      pushCopyForEvent('ride.status_changed', { status: 'arriving' })?.title,
    ).toBe('Driver arriving');
  });
});

describe('pushPolicyForEvent', () => {
  it('offers are critical, high priority, on the offers channel with the hail sound', () => {
    const policy = pushPolicyForEvent('ride.offer', {});
    expect(policy).toMatchObject({
      critical: true,
      priority: 'high',
      androidChannelId: ANDROID_CHANNEL_OFFERS,
      sound: 'hebir_offer',
      interruptionLevel: 'time-sensitive',
    });
  });

  it('offer TTL follows the server deadline and never outlives the offer window', () => {
    const soon = new Date(Date.now() + 30_000).toISOString();
    expect(
      pushPolicyForEvent('ride.offer', { offerExpiresAt: soon })?.ttlSeconds,
    ).toBeLessThanOrEqual(31);
    const far = new Date(Date.now() + 3_600_000).toISOString();
    expect(
      pushPolicyForEvent('ride.offer', { offerExpiresAt: far })?.ttlSeconds,
    ).toBe(120);
    expect(pushPolicyForEvent('ride.offer', {})?.ttlSeconds).toBe(120);
  });

  it('chat is not critical (socket-first) and collapses per ride', () => {
    const policy = pushPolicyForEvent('ride.chat_message', { rideId: 'r1' });
    expect(policy?.critical).toBe(false);
    expect(policy?.androidChannelId).toBe(ANDROID_CHANNEL_TRIP);
    expect(policy?.collapseKey).toBe('ride.chat:r1');
  });

  it('cancellation and SOS always wake the phone', () => {
    expect(pushPolicyForEvent('ride.cancelled', {})?.critical).toBe(true);
    expect(pushPolicyForEvent('incident.sos_peer', {})?.critical).toBe(true);
  });
});

describe('buildFcmMessage', () => {
  it('sets Android channel/TTL and APNs headers from the policy', () => {
    const policy = pushPolicyForEvent('ride.offer', { rideId: 'ride-1' })!;
    const message = buildFcmMessage({
      token: 'tok',
      platform: 'android',
      event: 'ride.offer',
      copy: { title: 'T', body: 'B' },
      policy,
      payload: { rideId: 'ride-1', pickup: { lat: 9, lng: 38 } },
    }) as any;

    expect(message.token).toBe('tok');
    expect(message.notification).toEqual({ title: 'T', body: 'B' });
    expect(message.data).toEqual({
      event: 'ride.offer',
      rideId: 'ride-1',
      route: 'offer',
    });
    expect(message.android.priority).toBe('HIGH');
    expect(message.android.ttl).toBe('120s');
    expect(message.android.collapse_key).toBe('ride.offer');
    expect(message.android.notification.channel_id).toBe(
      ANDROID_CHANNEL_OFFERS,
    );
    expect(message.android.notification.sound).toBe('hebir_offer');
    expect(message.apns.headers['apns-priority']).toBe('10');
    expect(message.apns.headers['apns-push-type']).toBe('alert');
    expect(message.apns.headers['apns-collapse-id']).toBe('ride.offer');
    expect(message.apns.payload.aps.sound).toBe('hebir_offer.wav');
    expect(message.apns.payload.aps['interruption-level']).toBe(
      'time-sensitive',
    );
  });

  it('uses the default sound and normal priority for low-urgency events', () => {
    const policy = pushPolicyForEvent('tip.received', {})!;
    const message = buildFcmMessage({
      token: 'tok',
      platform: 'ios',
      event: 'tip.received',
      copy: { title: 'T', body: 'B' },
      policy,
      payload: {},
    }) as any;
    expect(message.android.priority).toBe('NORMAL');
    expect(message.apns.headers['apns-priority']).toBe('5');
    expect(message.apns.payload.aps.sound).toBe('default');
    expect(message.data.route).toBe('earnings');
  });
});

describe('routeForEvent', () => {
  it('maps events to app routes', () => {
    expect(routeForEvent('ride.offer')).toBe('offer');
    expect(routeForEvent('ride.chat_message')).toBe('chat');
    expect(routeForEvent('ride.status_changed')).toBe('trip');
    expect(routeForEvent('subscription.suspended')).toBe('subscription');
  });
});

describe('classifyFcmFailure', () => {
  it('deletes dead tokens, retries transient failures, logs the rest', () => {
    expect(classifyFcmFailure(404, '')).toBe('dead-token');
    expect(
      classifyFcmFailure(
        400,
        '{"error":{"message":"The registration token is not a valid FCM registration token"}}',
      ),
    ).toBe('dead-token');
    expect(
      classifyFcmFailure(
        404,
        '{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}',
      ),
    ).toBe('dead-token');
    expect(classifyFcmFailure(429, '')).toBe('retryable');
    expect(classifyFcmFailure(503, '')).toBe('retryable');
    expect(classifyFcmFailure(400, 'bad payload')).toBe('permanent');
    expect(classifyFcmFailure(403, 'SENDER_ID_MISMATCH')).toBe('permanent');
  });
});

describe('flattenPushData', () => {
  it('stringifies scalars, drops nested objects and reserved keys', () => {
    expect(
      flattenPushData({
        rideId: 'r',
        n: 3,
        ok: true,
        nested: { a: 1 },
        from: 'x',
        'google.ttl': 1,
        none: null,
      }),
    ).toEqual({ rideId: 'r', n: '3', ok: 'true' });
  });
});

describe('loadFcmServiceAccount', () => {
  const sa = {
    project_id: 'ridehebir-prod-2026',
    client_email: 'fcm@ridehebir-prod-2026.iam.gserviceaccount.com',
    private_key:
      '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
  };

  it('falls back to the shared FIREBASE_SERVICE_ACCOUNT_JSON and unescapes the key', () => {
    const loaded = loadFcmServiceAccount(
      new ConfigService({ FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) }),
    );
    expect(loaded?.project_id).toBe('ridehebir-prod-2026');
    expect(loaded?.private_key).toContain('\nabc\n');
    expect(loaded?.private_key).not.toContain('\\n');
  });

  it('accepts base64-encoded JSON', () => {
    const encoded = Buffer.from(JSON.stringify(sa)).toString('base64');
    expect(
      loadFcmServiceAccount(
        new ConfigService({ FCM_SERVICE_ACCOUNT_JSON: encoded }),
      )?.client_email,
    ).toBe(sa.client_email);
  });

  it('returns null for garbage or incomplete accounts', () => {
    expect(
      loadFcmServiceAccount(
        new ConfigService({ FCM_SERVICE_ACCOUNT_JSON: '{' }),
      ),
    ).toBeNull();
    expect(
      loadFcmServiceAccount(
        new ConfigService({
          FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: 'x' }),
        }),
      ),
    ).toBeNull();
    expect(loadFcmServiceAccount(new ConfigService({}))).toBeNull();
  });
});
