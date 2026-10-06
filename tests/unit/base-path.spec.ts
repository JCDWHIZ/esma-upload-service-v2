/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';
import { validateConfig } from '../../src/config/schema.js';
import { AppConfigService } from '../../src/config/config.service.js';

@Controller('health')
class TestHealthController {
  @Get('live')
  getLive() {
    return { status: 'ok' };
  }
}

@Controller('metrics')
class TestMetricsController {
  @Get()
  getMetrics() {
    return '# HELP process_cpu\n# TYPE process_cpu counter\n';
  }
}

@Controller('api/v1/files')
class TestFilesController {
  @Get('ping')
  getPing() {
    return { ok: true };
  }
}

@Module({
  controllers: [
    TestHealthController,
    TestMetricsController,
    TestFilesController,
  ],
})
class TestAppModule {}

describe('Base Path Configuration and Routing (/uploads)', () => {
  describe('Config Schema & Service', () => {
    it('defaults BASE_PATH to /uploads', () => {
      const { config } = validateConfig({});
      expect(config.BASE_PATH).toBe('/uploads');
    });

    it('exposes basePath getter on AppConfigService', () => {
      const configService = new AppConfigService({});
      expect(configService.basePath).toBe('/uploads');
    });

    it('allows custom BASE_PATH override via environment', () => {
      const { config } = validateConfig({ BASE_PATH: '/custom-uploads' });
      expect(config.BASE_PATH).toBe('/custom-uploads');
    });
  });

  describe('HTTP Routing with Global Prefix and Rewrite Middleware', () => {
    let app: INestApplication;

    beforeAll(async () => {
      const moduleFixture = await Test.createTestingModule({
        imports: [TestAppModule],
      }).compile();

      app = moduleFixture.createNestApplication();

      const rawBasePath = '/uploads';
      const basePath = rawBasePath.replace(/^\/+|\/+$/g, '');

      if (basePath) {
        app.setGlobalPrefix(basePath);

        app.use((req: Request, _res: Response, next: NextFunction) => {
          const pathOnly = (req.url || '/').split('?')[0];
          if (
            !pathOnly.startsWith(`/${basePath}`) &&
            (pathOnly.startsWith('/health') ||
              pathOnly === '/metrics' ||
              pathOnly.startsWith('/metrics?') ||
              pathOnly === '/docs' ||
              pathOnly.startsWith('/docs/'))
          ) {
            req.url = `/${basePath}${req.url}`;
          }
          next();
        });
      }

      await app.init();
    });

    afterAll(async () => {
      if (app) {
        await app.close();
      }
    });

    it('serves files API route under /uploads/api/v1/files/ping', async () => {
      const res = await request(app.getHttpServer())
        .get('/uploads/api/v1/files/ping')
        .expect(200);

      expect(res.body).toEqual({ ok: true });
    });

    it('serves health liveness check directly under /uploads/health/live', async () => {
      const res = await request(app.getHttpServer())
        .get('/uploads/health/live')
        .expect(200);

      expect(res.body).toEqual({ status: 'ok' });
    });

    it('serves metrics endpoint directly under /uploads/metrics', async () => {
      const res = await request(app.getHttpServer())
        .get('/uploads/metrics')
        .expect(200);

      expect(res.text).toContain('process_cpu');
    });

    it('rewrites unprefixed /health/live to /uploads/health/live for backwards compatibility', async () => {
      const res = await request(app.getHttpServer())
        .get('/health/live')
        .expect(200);

      expect(res.body).toEqual({ status: 'ok' });
    });

    it('rewrites unprefixed /metrics to /uploads/metrics for backwards compatibility', async () => {
      const res = await request(app.getHttpServer())
        .get('/metrics')
        .expect(200);

      expect(res.text).toContain('process_cpu');
    });

    it('returns 404 for un-prefixed non-whitelisted paths', async () => {
      await request(app.getHttpServer()).get('/api/v1/files/ping').expect(404);
    });
  });
});
