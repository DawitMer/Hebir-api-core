import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { buildKycS3Client, isCloudflareR2Endpoint } from './s3-client';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject } from '@nestjs/common';
import Redis from 'ioredis';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { REDIS_CLIENT } from '../../redis/redis.module';

export type KycStorageMode = 's3' | 'local';

@Injectable()
export class KycStorageService {
  private readonly logger = new Logger(KycStorageService.name);
  private readonly mode: KycStorageMode;
  private readonly bucket: string;
  private readonly region: string;
  private readonly publicApiBase: string;
  private readonly localRoot: string;
  private readonly viewSecret: string;
  private readonly s3: S3Client | null;

  constructor(
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    const bucket = this.config.get<string>('S3_BUCKET')?.trim();
    const accessKey = this.config.get<string>('S3_ACCESS_KEY_ID')?.trim();
    const secretKey = this.config.get<string>('S3_SECRET_ACCESS_KEY')?.trim();
    const forced = this.config.get<string>('KYC_STORAGE_MODE')?.trim() as
      KycStorageMode | undefined;

    // Its own secret: a document view link must not be forgeable by anyone who
    // learns the JWT signing key, and rotating one should not break the other.
    const viewSecret =
      this.config.get<string>('KYC_VIEW_SECRET')?.trim() ||
      this.config.get<string>('JWT_ACCESS_SECRET')?.trim();
    if (!viewSecret) {
      throw new Error('KYC_VIEW_SECRET (or JWT_ACCESS_SECRET) must be set');
    }
    this.viewSecret = viewSecret;

    const isProd = this.config.get<string>('NODE_ENV') === 'production';
    const wantLocal = forced === 'local' || !bucket || !accessKey || !secretKey;
    if (wantLocal) {
      if (isProd) {
        throw new Error(
          'KYC storage: production requires KYC_STORAGE_MODE=s3 with S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY (local disk is ephemeral and unsafe across replicas)',
        );
      }
      this.mode = 'local';
      this.s3 = null;
      this.logger.log('KYC storage mode: local (.local-data/kyc-uploads)');
    } else {
      this.mode = 's3';
      const endpoint = this.config.get<string>('S3_ENDPOINT')?.trim();
      this.s3 = buildKycS3Client({
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
        region: this.config.get<string>('S3_REGION'),
        endpoint,
      });
      this.logger.log(`KYC storage mode: s3 bucket=${bucket}`);
    }

    this.bucket = bucket ?? 'hebir-kyc-local';
    const endpoint = this.config.get<string>('S3_ENDPOINT')?.trim();
    this.region = isCloudflareR2Endpoint(endpoint)
      ? (this.config.get<string>('S3_REGION') ?? 'auto')
      : (this.config.get<string>('S3_REGION') ?? 'us-east-1');
    this.publicApiBase = (
      this.config.get<string>('PUBLIC_API_BASE_URL') ??
      `http://127.0.0.1:${this.config.get<number>('PORT') ?? 3000}`
    ).replace(/\/$/, '');
    this.localRoot = path.resolve(
      process.cwd(),
      '..',
      '.local-data',
      'kyc-uploads',
    );
  }

  get storageMode(): KycStorageMode {
    return this.mode;
  }

  buildObjectKey(driverId: string, documentType: string, contentType: string) {
    const ext = this.extensionFor(contentType);
    return `kyc/${driverId}/${documentType}/${randomUUID()}${ext}`;
  }

  async createUploadUrl(params: {
    driverId: string;
    storageKey: string;
    contentType: string;
    expiresSeconds?: number;
  }): Promise<{ uploadUrl: string; headers: Record<string, string> }> {
    const expires = params.expiresSeconds ?? 900;
    await this.redis.set(
      `kyc:upload:${params.storageKey}`,
      params.driverId,
      'EX',
      expires,
    );

    if (this.mode === 's3' && this.s3) {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: params.storageKey,
        ContentType: params.contentType,
      });
      const uploadUrl = await getSignedUrl(this.s3, command, {
        expiresIn: expires,
      });
      return {
        uploadUrl,
        headers: { 'Content-Type': params.contentType },
      };
    }

    return {
      uploadUrl: `/kyc/me/documents/upload-body?key=${encodeURIComponent(params.storageKey)}`,
      headers: { 'Content-Type': params.contentType },
    };
  }

  async createViewUrl(storageKey: string, expiresSeconds = 3600) {
    if (this.mode === 's3' && this.s3) {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
      });
      return getSignedUrl(this.s3, command, { expiresIn: expiresSeconds });
    }
    const exp = Math.floor(Date.now() / 1000) + expiresSeconds;
    const sig = this.signView(storageKey, exp);
    return (
      `${this.publicApiBase}/kyc/documents/view-local` +
      `?key=${encodeURIComponent(storageKey)}&exp=${exp}&sig=${sig}`
    );
  }

  /**
   * Rider/driver clients already know API_BASE_URL. Local KYC files are
   * returned as a path so the emulator does not have to reach 127.0.0.1.
   */
  async createClientViewUrl(storageKey: string, expiresSeconds = 6 * 3600) {
    if (this.mode === 's3' && this.s3) {
      return this.createViewUrl(storageKey, expiresSeconds);
    }
    const exp = Math.floor(Date.now() / 1000) + expiresSeconds;
    const sig = this.signView(storageKey, exp);
    return (
      `/kyc/documents/view-local` +
      `?key=${encodeURIComponent(storageKey)}&exp=${exp}&sig=${sig}`
    );
  }

  verifyViewSignature(storageKey: string, exp: number, sig: string) {
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
    const expected = this.signView(storageKey, exp);
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
    } catch {
      return false;
    }
  }

  private signView(storageKey: string, exp: number) {
    return crypto
      .createHmac('sha256', this.viewSecret)
      .update(`${storageKey}:${exp}`)
      .digest('hex');
  }

  async assertPendingUpload(storageKey: string, driverId: string) {
    const owner = await this.redis.get(`kyc:upload:${storageKey}`);
    return owner === driverId;
  }

  async markUploaded(storageKey: string) {
    await this.redis.del(`kyc:upload:${storageKey}`);
  }

  async saveLocalBody(storageKey: string, body: Buffer, driverId: string) {
    const owner = await this.redis.get(`kyc:upload:${storageKey}`);
    if (owner !== driverId) {
      throw new Error('Upload not authorized or expired');
    }
    const full = this.resolveLocalPath(storageKey);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
  }

  async readLocalBody(storageKey: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolveLocalPath(storageKey));
    } catch {
      return null;
    }
  }

  /**
   * Confines a storage key to the upload root. Keys reach us from signed URLs,
   * so a `../` in one must not be able to read arbitrary files off disk.
   */
  private resolveLocalPath(storageKey: string): string {
    const resolved = path.resolve(this.localRoot, storageKey);
    if (
      resolved !== this.localRoot &&
      !resolved.startsWith(this.localRoot + path.sep)
    ) {
      throw new Error('Storage key escapes the upload root');
    }
    return resolved;
  }

  private extensionFor(contentType: string) {
    switch (contentType.toLowerCase()) {
      case 'image/jpeg':
      case 'image/jpg':
        return '.jpg';
      case 'image/png':
        return '.png';
      case 'image/webp':
        return '.webp';
      case 'application/pdf':
        return '.pdf';
      default:
        return '.bin';
    }
  }
}
