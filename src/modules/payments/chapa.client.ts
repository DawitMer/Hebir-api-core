import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserAccount } from '../auth/entities/user-account.entity';
import { toEthiopiaNational10 } from '../../common/phone/ethiopia-phone';
import { PaymentProvider } from '../subscription/entities/payment-event.entity';

const CHAPA_INIT = 'https://api.chapa.co/v1/transaction/initialize';
const CHAPA_VERIFY = 'https://api.chapa.co/v1/transaction/verify';

export type ChapaCheckout = {
  checkoutUrl: string;
  txRef: string;
  amountEtb: string;
  provider: PaymentProvider;
};

export type ChapaVerifiedCharge = {
  txRef: string;
  amountEtb: string;
  currency: string;
  status: string;
  driverId: string;
  raw: Record<string, unknown>;
};

/**
 * Chapa hosted checkout. Never treats initialize as paid — callers must
 * verify the transaction (WAITING_FOR_PROVIDER_SETUP without CHAPA_SECRET_KEY).
 */
@Injectable()
export class ChapaClient {
  private readonly logger = new Logger(ChapaClient.name);

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(UserAccount)
    private readonly users: Repository<UserAccount>,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('CHAPA_SECRET_KEY')?.trim());
  }

  webhookSecret(): string | undefined {
    return (
      this.config.get<string>('CHAPA_WEBHOOK_SECRET')?.trim() ||
      this.config.get<string>('PAYMENT_WEBHOOK_SECRET')?.trim()
    );
  }

  /**
   * Chapa signs `x-chapa-signature` as HMAC-SHA256(secret, raw body).
   * `chapa-signature` is HMAC-SHA256(secret, secret) on some dashboard setups.
   */
  verifyWebhookSignature(
    rawBody: Buffer,
    headers: Record<string, unknown>,
  ): boolean {
    const secret = this.webhookSecret();
    if (!secret || !rawBody?.length) return false;
    const payloadSig = this.header(headers, 'x-chapa-signature');
    const keySig = this.header(headers, 'chapa-signature');
    const expectedPayload = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');
    const expectedKey = crypto
      .createHmac('sha256', secret)
      .update(secret)
      .digest('hex');
    return (
      this.safeEqualHex(payloadSig, expectedPayload) ||
      this.safeEqualHex(keySig, expectedKey) ||
      this.safeEqualHex(keySig, expectedPayload)
    );
  }

  async initializeSubscriptionCheckout(input: {
    driverId: string;
    amountEtb: number;
  }): Promise<ChapaCheckout> {
    const secret = this.config.get<string>('CHAPA_SECRET_KEY')?.trim();
    if (!secret) {
      throw new ServiceUnavailableException(
        'Chapa is not configured (set CHAPA_SECRET_KEY) — WAITING_FOR_PROVIDER_SETUP',
      );
    }
    const driver = await this.users.findOne({ where: { id: input.driverId } });
    if (!driver) {
      throw new ServiceUnavailableException('Driver account not found');
    }

    const txRef = `s.${driver.id.replace(/-/g, '')}.${crypto.randomBytes(4).toString('hex')}`;
    const publicBase = (
      this.config.get<string>('PUBLIC_API_BASE_URL') ?? 'http://127.0.0.1:3000'
    ).replace(/\/$/, '');
    const phone = toEthiopiaNational10(driver.phoneNumber) ?? undefined;
    const amount = String(input.amountEtb);
    const names = (driver.fullName ?? 'Hebir Driver').trim().split(/\s+/);
    const firstName = names[0] || 'Driver';
    const lastName = names.slice(1).join(' ') || 'Hebir';

    const res = await fetch(CHAPA_INIT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount,
        currency: 'ETB',
        email: `driver.${driver.id.replace(/-/g, '').slice(0, 12)}@invalid.invalid`,
        first_name: firstName.slice(0, 50),
        last_name: lastName.slice(0, 50),
        ...(phone ? { phone_number: phone } : {}),
        tx_ref: txRef,
        callback_url: `${publicBase}/subscription/chapa/callback`,
        return_url: `${publicBase}/subscription/chapa/return`,
        customization: {
          title: 'Hebir Driver',
          description: 'Monthly driver access',
        },
        meta: { driverId: driver.id, kind: 'subscription' },
      }),
    });

    const json = (await res.json().catch(() => null)) as {
      status?: string;
      message?: string;
      data?: { checkout_url?: string };
    } | null;
    const checkoutUrl = json?.data?.checkout_url;
    if (!res.ok || json?.status !== 'success' || !checkoutUrl) {
      this.logger.warn(
        `Chapa initialize failed: ${res.status} ${json?.message ?? ''}`,
      );
      throw new ServiceUnavailableException(
        'Chapa did not return a checkout URL',
      );
    }

    return {
      checkoutUrl,
      txRef,
      amountEtb: amount,
      provider: PaymentProvider.CHAPA,
    };
  }

  async verifyTxRef(txRef: string): Promise<ChapaVerifiedCharge> {
    const secret = this.config.get<string>('CHAPA_SECRET_KEY')?.trim();
    if (!secret) {
      throw new ServiceUnavailableException(
        'Chapa is not configured (set CHAPA_SECRET_KEY)',
      );
    }
    const res = await fetch(`${CHAPA_VERIFY}/${encodeURIComponent(txRef)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const json = (await res.json().catch(() => null)) as {
      status?: string;
      data?: {
        status?: string;
        amount?: number | string;
        currency?: string;
        tx_ref?: string;
        meta?: { driverId?: string } | string | null;
      };
    } | null;
    const data = json?.data;
    if (!res.ok || json?.status !== 'success' || !data) {
      throw new ServiceUnavailableException(
        'Chapa could not verify the transaction',
      );
    }
    const meta =
      data.meta && typeof data.meta === 'object'
        ? data.meta
        : typeof data.meta === 'string'
          ? (JSON.parse(data.meta) as { driverId?: string })
          : {};
    const driverId =
      meta.driverId ?? this.driverIdFromTxRef(data.tx_ref ?? txRef);
    if (!driverId) {
      throw new ServiceUnavailableException(
        'Chapa transaction is missing driverId',
      );
    }
    return {
      txRef: data.tx_ref ?? txRef,
      amountEtb: String(data.amount ?? ''),
      currency: data.currency ?? 'ETB',
      status: (data.status ?? '').toLowerCase(),
      driverId,
      raw: data as Record<string, unknown>,
    };
  }

  driverIdFromTxRef(txRef: string): string | null {
    const match = /^s\.([0-9a-f]{32})\.[0-9a-f]+$/i.exec(txRef.trim());
    if (!match) return null;
    const hex = match[1];
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  private header(headers: Record<string, unknown>, name: string): string {
    const direct = headers[name] ?? headers[name.toLowerCase()];
    if (typeof direct === 'string') return direct;
    if (Array.isArray(direct) && typeof direct[0] === 'string')
      return direct[0];
    return '';
  }

  private safeEqualHex(provided: string, expected: string): boolean {
    if (!provided || !expected) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}
