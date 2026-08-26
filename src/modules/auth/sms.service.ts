import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { toEthiopiaBareMsisdn } from '../../common/phone/ethiopia-phone';

/**
 * Sends OTP SMS through a configured provider. Production must set
 * SMS_PROVIDER to afromessage|geezsms|twilio|http and matching credentials.
 */
@Injectable()
export class SmsService {
  constructor(private readonly config: ConfigService) {}

  async sendOtp(phoneNumber: string, code: string): Promise<void> {
    const provider = (this.config.get<string>('SMS_PROVIDER') ?? '')
      .trim()
      .toLowerCase();
    const body = `ህብር code: ${code}. Expires in 5 minutes. Do not share it.`;

    if (provider === 'afromessage') {
      await this.sendAfroMessage(phoneNumber, body);
      return;
    }
    if (provider === 'geezsms') {
      await this.sendGeezSms(phoneNumber, body);
      return;
    }
    if (provider === 'twilio') {
      await this.sendTwilio(phoneNumber, body);
      return;
    }
    if (provider === 'http' || provider === 'webhook') {
      await this.sendHttp(phoneNumber, body);
      return;
    }

    throw new ServiceUnavailableException(
      `Unknown SMS_PROVIDER="${provider}". Use afromessage, geezsms, twilio, or http.`,
    );
  }

  private async sendAfroMessage(to: string, message: string) {
    const token = this.config.get<string>('AFROMESSAGE_TOKEN')?.trim();
    if (!token) {
      throw new ServiceUnavailableException(
        'AfroMessage SMS requires AFROMESSAGE_TOKEN',
      );
    }
    const identifier = this.config.get<string>('AFROMESSAGE_FROM')?.trim();
    const sender = this.config.get<string>('AFROMESSAGE_SENDER')?.trim();
    const payload: Record<string, string> = { to, message };
    if (identifier) payload.from = identifier;
    if (sender) payload.sender = sender;

    const res = await fetch('https://api.afromessage.com/api/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new ServiceUnavailableException(
        'SMS provider rejected the message',
      );
    }
    const json = (await res.json().catch(() => null)) as {
      acknowledge?: string;
    } | null;
    if (json && json.acknowledge && json.acknowledge !== 'success') {
      throw new ServiceUnavailableException(
        'SMS provider rejected the message',
      );
    }
  }

  private async sendGeezSms(to: string, msg: string) {
    const token = this.config.get<string>('GEEZSMS_TOKEN')?.trim();
    if (!token) {
      throw new ServiceUnavailableException('GeezSMS requires GEEZSMS_TOKEN');
    }
    const phone = toEthiopiaBareMsisdn(to);
    if (!phone) {
      throw new ServiceUnavailableException(
        'SMS provider rejected the message',
      );
    }
    const shortcode = this.config.get<string>('GEEZSMS_SHORTCODE_ID')?.trim();
    const form = new URLSearchParams({ token, phone, msg });
    if (shortcode) form.set('shortcode_id', shortcode);

    const res = await fetch('https://api.geezsms.com/api/v1/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (!res.ok) {
      throw new ServiceUnavailableException(
        'SMS provider rejected the message',
      );
    }
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
