import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeviceToken } from './device-token.entity';
import {
  flattenPushData,
  googleAccessToken,
  loadFcmServiceAccount,
  pushCopyForEvent,
} from './fcm';

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly tokenCache: {
    current?: { value: string; expiresAtMs: number };
  } = {};

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(DeviceToken)
    private readonly tokens: Repository<DeviceToken>,
  ) {}

  isConfigured(): boolean {
    return Boolean(loadFcmServiceAccount(this.config));
  }

  async registerToken(userId: string, token: string, platform: string) {
    const trimmed = token.trim();
    if (!trimmed || trimmed.length > 512) return { registered: false };
    const existing = await this.tokens.findOne({ where: { token: trimmed } });
    if (existing) {
      existing.userId = userId;
      existing.platform = platform === 'ios' ? 'ios' : 'android';
      await this.tokens.save(existing);
      return { registered: true };
    }
    await this.tokens.save(
      this.tokens.create({
        userId,
        token: trimmed,
        platform: platform === 'ios' ? 'ios' : 'android',
      }),
    );
    return { registered: true };
  }

  async notifyEvent(
    userId: string,
    event: string,
    payload: unknown,
  ): Promise<void> {
    const copy = pushCopyForEvent(event, payload);
    if (!copy) return;
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
    if (!sa?.project_id || !sa.client_email || !sa.private_key) return;

    const devices = await this.tokens.find({ where: { userId } });
    if (devices.length === 0) return;

    let accessToken: string;
    try {
      accessToken = await googleAccessToken(sa, fetch, this.tokenCache);
    } catch (error) {
      this.logger.warn(`FCM auth failed: ${(error as Error).message}`);
      return;
    }

    const data = { event, ...flattenPushData(payload) };
    for (const device of devices) {
      try {
        const res = await fetch(
          `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              message: {
                token: device.token,
                notification: { title, body },
                data,
                android: { priority: 'HIGH' },
              },
            }),
          },
        );
        if (res.status === 404 || res.status === 410) {
          await this.tokens.delete({ id: device.id });
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          this.logger.warn(`FCM send ${res.status}: ${text.slice(0, 180)}`);
        }
      } catch (error) {
        this.logger.warn(`FCM send failed: ${(error as Error).message}`);
      }
    }
  }
}
