import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { GlobalExceptionFilter } from '../src/common/filters/http-exception.filter.js';

interface HealthBody {
  status: string;
  checks: { database: string; storage: string };
}

interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string;
  correlationId: string;
}

interface FileListBody {
  items: unknown[];
  total: number;
}

describe('App & Endpoints (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Health Checks', () => {
    it('/health/live (GET) should return 200 UP', () => {
      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];
      return request(server)
        .get('/health/live')
        .expect(200)
        .expect((res) => {
          const body = res.body as HealthBody;
          expect(body.status).toBe('UP');
        });
    });

    it('/health/ready (GET) should return 200 UP', () => {
      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];
      return request(server)
        .get('/health/ready')
        .expect(200)
        .expect((res) => {
          const body = res.body as HealthBody;
          expect(body.status).toBe('UP');
          expect(body.checks.database).toBe('UP');
          expect(body.checks.storage).toBe('UP');
        });
    });
  });

  describe('V1 Files Endpoints', () => {
    it('/api/v1/files (GET) should return file list', () => {
      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];
      return request(server)
        .get('/api/v1/files')
        .expect(200)
        .expect((res) => {
          const body = res.body as FileListBody;
          expect(body).toHaveProperty('items');
          expect(body).toHaveProperty('total');
        });
    });

    it('/api/v1/files/upload (POST) should return 501 Not Implemented with standard error JSON', () => {
      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];
      return request(server)
        .post('/api/v1/files/upload')
        .expect('Content-Type', /json/)
        .expect(501)
        .expect((res) => {
          const body = res.body as ErrorResponseBody;
          expect(body.error).toBe('NOT_IMPLEMENTED');
          expect(body.statusCode).toBe(501);
          expect(body.correlationId).toBeDefined();
        });
    });
  });
});
