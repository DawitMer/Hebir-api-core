import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  HeadObjectCommand,
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
import { treatAsProductionRuntime } from '../../config/public-api-host';

/**
 * `unavailable`: production-like runtime with no S3 configured. The API still
 * boots (rides, dispatch, auth keep working) but every KYC upload path answers
 * 503 instead of silently writing documents to an ephemeral disk.
 */
export type KycStorageMode = 's3' | 'local' | 'unavailable';

export const KYC_UPLOAD_UNAVAILABLE_MESSAGE =
  'Document upload is temporarily unavailable. Please try again later.';

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

    const isProd = treatAsProductionRuntime(
      this.config.get<string>('NODE_ENV'),
      this.config.get<string>('PUBLIC_API_BASE_URL'),
    );
    const wantLocal = forced === 'local' || !bucket || !accessKey || !secretKey;
    if (wantLocal && isProd) {
      // Do not take the whole API down over document storage: trips must keep
      // running. Uploads fail closed (503) until S3/R2 is configured.
      this.mode = 'unavailable';
      this.s3 = null;
      this.logger.error(
        'KYC storage: production requires KYC_STORAGE_MODE=s3 with S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY. Document uploads are DISABLED (503) until they are set.',
      );
    } else if (wantLocal) {
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
      this.config.get<string>('KYC_LOCAL_ROOT') ??
        path.join(process.cwd(), '..', '.local-data', 'kyc-uploads'),
    );
  }

  get storageMode(): KycStorageMode {
    return this.mode;
  }

  /** True when uploads can be accepted (S3, or local outside production). */
  get uploadsAvailable(): boolean {
    return this.mode !== 'unavailable';
  }

  private assertUploadsAvailable(): void {
    if (!this.uploadsAvailable) {
      throw new ServiceUnavailableException(KYC_UPLOAD_UNAVAILABLE_MESSAGE);
    }
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
    this.assertUploadsAvailable();
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
        IfNoneMatch: '*',
      });
      const uploadUrl = await getSignedUrl(this.s3, command, {
        expiresIn: expires,
        signableHeaders: new Set(['if-none-match', 'content-type']),
      });
      return {
        uploadUrl,
        headers: { 'Content-Type': params.contentType, 'If-None-Match': '*' },
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

  /** A presign is not proof that a non-empty, bounded object was uploaded. */
  async assertUploadedObject(storageKey: string): Promise<void> {
    this.assertUploadsAvailable();
    const maxBytes = 15 * 1024 * 1024;
    if (this.mode === 's3' && this.s3) {
      const object = await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: storageKey }),
        {
          abortSignal: AbortSignal.timeout(10000),
        },
      );
      if (
        !object.ContentLength ||
        object.ContentLength > maxBytes ||
        !/^(image\/(jpeg|jpg|png|webp)|application\/pdf)$/.test(
          object.ContentType ?? '',
        )
      ) {
        throw new Error(
          'Uploaded object is empty, too large or has an unsupported type',
        );
      }
    } else {
      const stat = await fs.stat(this.resolveLocalPath(storageKey));
      if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes)
        throw new Error('Invalid uploaded file size');
    }
  }

  async saveLocalBody(storageKey: string, body: Buffer, driverId: string) {
    this.assertUploadsAvailable();
    const owner = await this.redis.get(`kyc:upload:${storageKey}`);
    if (owner !== driverId) {
      throw new Error('Upload not authorized or expired');
    }
    const full = this.resolveLocalPath(storageKey);
    await fs.mkdir(path.dirname(full), { recursive: true });
    try {
      await fs.writeFile(full, body, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Uncertain retry of identical bytes is safe; an existing object is immutable.
      const existing = await fs.readFile(full);
      if (!existing.equals(body))
        throw new Error('Upload key already contains a different document');
    }
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
