import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { Repository } from 'typeorm';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { DeviceToken } from './device-token.entity';
import {
  buildFcmMessage,
  classifyFcmFailure,
  googleAccessToken,
  loadFcmServiceAccount,
  pushCopyForEvent,
  pushPolicyForEvent,
} from './fcm';

/**
 * Cross-instance WebSocket presence. The gateway adds a socket id on connect,
 * refreshes the TTL while the socket lives and removes it on disconnect, so a
 * crashed instance's entries age out instead of masking a phone forever.
 */
export const WS_PRESENCE_KEY_PREFIX = 'ws:online:';
export const WS_PRESENCE_TTL_SECONDS = 90;

const SEND_CONCURRENCY = 8;
const RETRY_DELAY_MS = 400;

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly tokenCache: {
    current?: { value: string; expiresAtMs: number };
  } = {};
  private warnedUnconfigured = false;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(DeviceToken)
    private readonly tokens: Repository<DeviceToken>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  isConfigured(): boolean {
    return Boolean(loadFcmServiceAccount(this.config));
  }

  async registerToken(userId: string, token: string, platform: string) {
    const trimmed = token.trim();
    if (!trimmed || trimmed.length > 512) return { registered: false };
    // A token that moves to another account (shared phone) is re-owned, not
    // duplicated: the unique index is on the token itself.
    await this.tokens.upsert(
      {
        userId,
        token: trimmed,
        platform: platform === 'ios' ? 'ios' : 'android',
      },
      ['token'],
    );
    return { registered: true };
  }

  async unregisterToken(userId: string, token: string) {
    await this.tokens.delete({ userId, token: token.trim() });
    return { unregistered: true };
  }

  /**
   * Lets a signed-in user verify their own device receives push (Settings →
   * "Send test notification"). Reports whether FCM is configured and how many
   * devices were targeted so support can read the answer back.
   */
  async sendTest(userId: string): Promise<{
    configured: boolean;
    devices: number;
  }> {
    const configured = this.isConfigured();
    const devices = await this.tokens.count({ where: { userId } });
    if (configured && devices > 0) {
      await this.send(
        userId,
        'push.test',
        'Hebir notifications are working',
        'You will be alerted about trips and messages on this phone.',
        { sentAt: new Date().toISOString() },
      );
    }
    return { configured, devices };
  }

  /** True when the user has at least one live socket on any API instance. */
  async hasLiveSocket(userId: string): Promise<boolean> {
    try {
      const count = await this.redis.scard(
        `${WS_PRESENCE_KEY_PREFIX}${userId}`,
      );
      return count > 0;
    } catch {
      // If presence is unknown, prefer delivering.
      return false;
    }
  }

  /**
   * Socket-first, push-second: non-critical events are only pushed when the
   * user has no live socket (otherwise they would see the in-app update and a
   * duplicate banner). Critical events (offers, cancellations, SOS) always go
   * out because a socket can be alive while the screen is locked.
   */
  async notifyEvent(
    userId: string,
    event: string,
    payload: unknown,
  ): Promise<void> {
    const policy = pushPolicyForEvent(event, payload);
    const copy = pushCopyForEvent(event, payload);
    if (!policy || !copy) return;
    if (!policy.critical && (await this.hasLiveSocket(userId))) return;
    await this.send(userId, event, copy.title, copy.body, payload);
  }

  async send(
    userId: string,
    event: string,
    title: string,
    body: string,
    payload: unknown,
  ): Promise<void> {
    const sa = loadFcmServiceAccount(this.config);
    if (!sa) {
      if (!this.warnedUnconfigured) {
        this.warnedUnconfigured = true;
        this.logger.warn(
          'FCM disabled: set FIREBASE_SERVICE_ACCOUNT_JSON (or FCM_SERVICE_ACCOUNT_JSON) to deliver push notifications',
        );
      }
      return;
    }

    const devices = await this.tokens.find({ where: { userId } });
    if (devices.length === 0) return;

    let accessToken: string;
    try {
      accessToken = await googleAccessToken(sa, fetch, this.tokenCache);
    } catch (error) {
      this.logger.warn(`FCM auth failed: ${(error as Error).message}`);
      return;
    }

    const policy = pushPolicyForEvent(event, payload) ?? {
      critical: false,
      priority: 'normal' as const,
      ttlSeconds: 3600,
      androidChannelId: 'hebir_general',
    };
    const endpoint = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(
      sa.project_id,
    )}/messages:send`;

    // Bounded parallelism: a driver with many stale devices must not serialise
    // an offer behind ten slow HTTP calls.
    const queue = [...devices];
    const workers = Array.from(
      { length: Math.min(SEND_CONCURRENCY, queue.length) },
      async () => {
        for (;;) {
          const device = queue.shift();
          if (!device) return;
          const message = buildFcmMessage({
            token: device.token,
            platform: device.platform,
            event,
            copy: { title, body },
            policy,
            payload,
          });
          await this.deliver(endpoint, accessToken, device, message, event);
        }
      },
    );
    await Promise.all(workers);
  }

  private async deliver(
    endpoint: string,
    accessToken: string,
    device: DeviceToken,
    message: Record<string, unknown>,
    event: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ message }),
        });
      } catch (error) {
        if (attempt === 0) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        this.logger.warn(
          `FCM ${event} network failure: ${(error as Error).message}`,
        );
        return;
      }
      if (res.ok) return;

      const text = await res.text().catch(() => '');
      const outcome = classifyFcmFailure(res.status, text);
      if (outcome === 'dead-token') {
        await this.tokens.delete({ id: device.id }).catch(() => undefined);
        return;
      }
      if (outcome === 'retryable' && attempt === 0) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      this.logger.warn(
        `FCM ${event} send ${res.status} (${device.platform}): ${text.slice(0, 180)}`,
      );
      return;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
