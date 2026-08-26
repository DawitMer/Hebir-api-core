import * as dotenv from 'dotenv';
dotenv.config();

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { buildKycS3Client } from '../src/modules/kyc/s3-client';

async function main() {
  const bucket = process.env.S3_BUCKET;
  const endpoint = process.env.S3_ENDPOINT;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const region = process.env.S3_REGION ?? 'auto';

  console.log('--- Cloudflare R2 Verification ---');
  console.log(`Endpoint : ${endpoint}`);
  console.log(`Bucket   : ${bucket}`);
  console.log(`AccessKey: ${accessKeyId?.slice(0, 8)}...`);

  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing S3/R2 credentials in environment');
  }

  const s3 = buildKycS3Client({
    accessKeyId,
    secretAccessKey,
    region,
    endpoint,
  });

  const testKey = `kyc/test-verify-${Date.now()}.txt`;
  const testBody = 'Hebir KYC verification payload — Cloudflare R2 is live!';

  console.log(`1. Uploading test object: ${testKey}`);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: testKey,
      Body: Buffer.from(testBody),
      ContentType: 'text/plain',
    }),
  );
  console.log('   ✓ Upload successful');

  console.log('2. Reading object back from R2...');
  const res = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: testKey,
    }),
  );
  const data = await res.Body?.transformToString();
  if (data !== testBody) {
    throw new Error(`Data mismatch: expected "${testBody}", got "${data}"`);
  }
  console.log(`   ✓ Read verified: "${data}"`);

  console.log('3. Generating Presigned Upload URL (15 min)...');
  const presignedPut = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: bucket,
      Key: `kyc/drivers/presigned-test.jpg`,
      ContentType: 'image/jpeg',
    }),
    { expiresIn: 900 },
  );
  console.log(`   ✓ Presigned URL generated: ${presignedPut.slice(0, 80)}...`);

  console.log('4. Cleaning up test object...');
  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: testKey,
    }),
  );
  console.log('   ✓ Cleanup successful');

  console.log('\n--> CLOUDFLARE R2 VERIFICATION 100% PASSED <--');
}

main().catch((err) => {
  console.error('R2 Verification failed:', err);
  process.exit(1);
});
