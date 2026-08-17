import {
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Sends OTP SMS through a configured provider. Production must set
 * SMS_PROVIDER=twilio|http and the matching credentials.
 */
@Injectable()
export class SmsService {
  constructor(private readonly config: ConfigService) {}

  async sendOtp(phoneNumber: string, code: string): Promise<void> {
    const provider = (this.config.get<string>('SMS_PROVIDER') ?? '')
      .trim()
      .toLowerCase();
    const body = `ህብር code: ${code}. Expires in 5 minutes. Do not share it.`;

    if (provider === 'twilio') {
      await this.sendTwilio(phoneNumber, body);
      return;
    }
    if (provider === 'http' || provider === 'webhook') {
      await this.sendHttp(phoneNumber, body);
      return;
    }

    throw new ServiceUnavailableException(
      `Unknown SMS_PROVIDER="${provider}". Use twilio or http.`,
    );
  }

  private async sendTwilio(to: string, body: string) {
    const sid = this.config.get<string>('TWILIO_ACCOUNT_SID')?.trim();
    const token = this.config.get<string>('TWILIO_AUTH_TOKEN')?.trim();
    const from = this.config.get<string>('TWILIO_FROM')?.trim();
    if (!sid || !token || !from) {
      throw new ServiceUnavailableException(
        'Twilio SMS requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM',
      );
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const params = new URLSearchParams({ To: to, From: from, Body: body });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    if (!res.ok) {
      throw new ServiceUnavailableException(
        'SMS provider rejected the message',
      );
    }
  }

  private async sendHttp(to: string, body: string) {
    const url = this.config.get<string>('SMS_HTTP_URL')?.trim();
    if (!url) {
      throw new ServiceUnavailableException(
        'SMS_HTTP_URL is required when SMS_PROVIDER=http',
      );
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, body }),
    });
    if (!res.ok) {
      throw new ServiceUnavailableException(
        'SMS provider rejected the message',
      );
    }
  }
}
