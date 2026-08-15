import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { HealthController } from '../src/modules/admin/health.controller';

/**
 * Lightweight HTTP smoke without Postgres/Redis.
 * Full stack smoke: `npm run smoke` against a running api-core.
 */
describe('Health (e2e smoke)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /healthz', async () => {
    // CommonJS require — esModule interop with supertest + ts-jest is flaky.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const request = require('supertest');
    await request(app.getHttpServer())
      .get('/healthz')
      .expect(200)
      .expect((res: { body: { ok: boolean; service: string } }) => {
        expect(res.body.ok).toBe(true);
        expect(res.body.service).toBe('api-core');
      });
  });
});
