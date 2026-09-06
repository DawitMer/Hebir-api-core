import { ConfigService } from '@nestjs/config';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { KycStorageService } from './kyc-storage.service';

describe('KYC upload immutability', () => {
  const redis = {
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue('driver'),
  };

  it('signs the overwrite-prevention header without contacting S3', async () => {
    const service = new KycStorageService(
      new ConfigService({
        NODE_ENV: 'test',
        KYC_STORAGE_MODE: 's3',
        S3_BUCKET: 'isolated-audit-fixture',
        S3_ACCESS_KEY_ID: 'isolated-fake-access',
        S3_SECRET_ACCESS_KEY: 'isolated-fake-secret',
        KYC_VIEW_SECRET: 'isolated-fake-view-secret',
      }),
      redis as never,
    );
    const result = await service.createUploadUrl({
      driverId: 'driver',
      storageKey: 'kyc/driver/license/test.jpg',
      contentType: 'image/jpeg',
    });
    expect(result.headers['If-None-Match']).toBe('*');
    expect(
      new URL(result.uploadUrl).searchParams.has('x-amz-checksum-crc32'),
    ).toBe(false);
    expect(
      new URL(result.uploadUrl).searchParams
        .get('X-Amz-SignedHeaders')
        ?.split(';'),
    ).toEqual(expect.arrayContaining(['if-none-match', 'content-type']));
  });

  let directory: string;
  let local: KycStorageService;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hebir-kyc-test-'));
    local = new KycStorageService(
      new ConfigService({
        NODE_ENV: 'test',
        KYC_STORAGE_MODE: 'local',
        KYC_LOCAL_ROOT: directory,
        KYC_VIEW_SECRET: 'isolated-fake-view-secret',
      }),
      redis as never,
    );
  });
  afterEach(async () => {
    // Only the exact test-owned directory returned by mkdtemp.
    await rm(directory, { recursive: true, force: true });
  });

  it('allows identical retries but never overwrites an uploaded local document', async () => {
    const key = 'kyc/driver/license/test.jpg';
    await local.saveLocalBody(key, Buffer.from('original'), 'driver');
    await local.saveLocalBody(key, Buffer.from('original'), 'driver');
    await expect(
      local.saveLocalBody(key, Buffer.from('replacement'), 'driver'),
    ).rejects.toThrow('different document');
    expect(await local.readLocalBody(key)).toEqual(Buffer.from('original'));
    await local.assertUploadedObject(key);
  });

  it('rejects traversal and wrong ownership', async () => {
    await expect(
      local.saveLocalBody('../../escape', Buffer.from('x'), 'driver'),
    ).rejects.toThrow('escapes');
    await expect(
      local.saveLocalBody('kyc/other/test.jpg', Buffer.from('x'), 'other'),
    ).rejects.toThrow('authorized');
  });

  it('does not accept an empty file as an uploaded document', async () => {
    const key = 'kyc/driver/license/empty.jpg';
    await local.saveLocalBody(key, Buffer.alloc(0), 'driver');
    await expect(local.assertUploadedObject(key)).rejects.toThrow('size');
  });
});
