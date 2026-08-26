import { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';

export function isCloudflareR2Endpoint(endpoint?: string): boolean {
  return Boolean(endpoint?.includes('r2.cloudflarestorage.com'));
}

/** S3-compatible client. Cloudflare R2 needs region=auto and no extra checksums. */
export function buildKycS3Client(input: {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  endpoint?: string;
}): S3Client {
  const r2 = isCloudflareR2Endpoint(input.endpoint);
  const config: S3ClientConfig = {
    region: r2
      ? input.region?.trim() || 'auto'
      : input.region?.trim() || 'us-east-1',
    credentials: {
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
    },
  };
  if (input.endpoint) {
    config.endpoint = input.endpoint;
    // MinIO is path-style; R2 prefers virtual-hosted buckets.
    config.forcePathStyle = !r2;
  }
  if (r2) {
    config.requestChecksumCalculation = 'WHEN_REQUIRED';
    config.responseChecksumValidation = 'WHEN_REQUIRED';
  }
  return new S3Client(config);
}
