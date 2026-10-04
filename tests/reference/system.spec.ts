import { describe, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createReferenceApp } from './helpers/reference-app.factory.js';
import { assertContractFixture } from './helpers/fixture-manager.js';

describe('System & Documentation Contract Reference Suite', () => {
  let app: INestApplication;
  const server = () =>
    app.getHttpServer() as unknown as Parameters<typeof request>[0];

  beforeAll(async () => {
    const res = await createReferenceApp();
    app = res.app;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Route 14: GET /api/test', () => {
    it('returns legacy health check greeting', async () => {
      const res = await request(server()).get('/api/test');

      await assertContractFixture('system.test.success', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });
  });

  describe('Route 15: GET /docs.json', () => {
    it('returns valid OpenAPI JSON specification', async () => {
      const res = await request(server()).get('/docs.json');

      await assertContractFixture('system.docs.success', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });
  });

  describe('Route 16: GET /', () => {
    it('serves interactive Swagger documentation HTML', async () => {
      const res = await request(server()).get('/');

      await assertContractFixture('system.swagger-ui.success', {
        status: res.status,
        headers: res.headers,
        body: res.text,
      });
    });
  });

  describe('Route 17: GET /uploads/*', () => {
    it('rejects public disk browsing and returns 404 (corrected defect F-47)', async () => {
      const res = await request(server()).get('/uploads/arbitrary-file.txt');

      await assertContractFixture('system.uploads-static.not-found', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });
  });
});
