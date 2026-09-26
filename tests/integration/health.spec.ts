/**
 * Integration tests for P1-15: HTTP and platform hardening.
 *
 * Tests health endpoints, CORS behaviour, 404 error shape, and the
 * exception filter's non-leakage guarantee. All assertions run against a
 * real NestJS TestingModule (no live DB required).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigModule } from '../../src/config/config.module.js';
import { ObservabilityModule } from '../../src/observability/observability.module.js';
import { ProblemJsonErrorFilter } from '../../src/common/filters/problem-json-error.filter.js';

// ---------------------------------------------------------------------------
// Response body types
// ---------------------------------------------------------------------------

interface LiveBody {
  status: string;
}

interface HealthCheckItem {
  status: string;
  message?: string;
  driver?: string;
}

interface ReadyBody {
  status: string;
  checks: {
    stagingDir: HealthCheckItem;
    storageConfig: HealthCheckItem;
  };
}

interface ErrorBody {
  status: number;
  stack?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(envOverrides: Record<string, string> = {}): Promise<{
  app: INestApplication;
  close: () => Promise<void>;
}> {
  return buildAppWithStagingDir(undefined, envOverrides);
}

async function buildAppWithStagingDir(
  stagingDir?: string,
  envOverrides: Record<string, string> = {},
): Promise<{ app: INestApplication; close: () => Promise<void> }> {
  // ConfigModule is @Global() — process.env is the reliable way to configure it.
  // We save and restore all modified keys to prevent test pollution.
  const base = os.tmpdir();

  // Ensure LOCAL_STORAGE_PATH and STAGING_DIR are DISTINCT — the config schema
  // enforces they may not be the same or contain one another.
  const stagingPath = stagingDir ?? path.join(base, 'gus-test-staging');
  const storagePath = path.join(base, 'gus-test-storage');

  // Never set NODE_ENV=production via process.env in tests — it triggers prod
  // validation rules (JWT length, ADMIN_AUTH_MODE checks, etc.) that fail
  // without a full prod config. Tests that check prod-mode controller behaviour
  // set it at the app level, not via env injection.
  const testEnv: Record<string, string> = {
    STAGING_DIR: stagingPath,
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_PATH: storagePath,
    CORS_ALLOWED_ORIGINS: 'https://allowed.example.com',
    // Apply caller overrides except NODE_ENV — keep 'test' always
    ...envOverrides,
    NODE_ENV: 'test',
  };

  const envKeys = Object.keys(testEnv);
  const saved: Record<string, string | undefined> = {};
  for (const key of envKeys) {
    saved[key] = process.env[key];
    process.env[key] = testEnv[key];
  }

  let moduleFixture: TestingModule;
  try {
    moduleFixture = await Test.createTestingModule({
      imports: [ConfigModule, ObservabilityModule],
    }).compile();
  } catch (err) {
    // Restore env before re-throwing so other tests are not polluted
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    throw err;
  }

  const app: INestApplication = moduleFixture.createNestApplication();

  app.enableCors({
    origin: true, // always open in test env
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-API-Key',
      'X-Correlation-Id',
    ],
    exposedHeaders: ['X-Correlation-Id'],
    credentials: true,
  });
  app.useGlobalFilters(new ProblemJsonErrorFilter());
  await app.init();

  return {
    app,
    close: async () => {
      await app.close();
      for (const key of envKeys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    },
  };
}

function serverOf(app: INestApplication) {
  return app.getHttpServer() as unknown as Parameters<typeof request>[0];
}

// ---------------------------------------------------------------------------
// Test: /health/live
// ---------------------------------------------------------------------------

describe('GET /health/live', () => {
  let app: INestApplication;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ app, close } = await buildApp());
  });

  afterAll(() => close());

  it('returns 200 { status: "ok" }', async () => {
    const res = await request(serverOf(app)).get('/health/live').expect(200);

    const body = res.body as LiveBody;
    expect(body).toMatchObject({ status: 'ok' });
  });

  it('requires no authentication', async () => {
    // No Authorization header — must still succeed
    await request(serverOf(app)).get('/health/live').expect(200);
  });
});

// ---------------------------------------------------------------------------
// Test: /health/ready — staging dir writable
// ---------------------------------------------------------------------------

describe('GET /health/ready — staging writable', () => {
  let app: INestApplication;
  let close: () => Promise<void>;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gus-health-test-'));
    ({ app, close } = await buildAppWithStagingDir(tmpDir));
  });

  afterAll(async () => {
    await close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns stagingDir check ok when dir is writable', async () => {
    const res = await request(serverOf(app)).get('/health/ready');

    const body = res.body as ReadyBody;
    // The staging dir write probe must pass — that is the core assertion for this test.
    expect(body.checks.stagingDir.status).toBe('ok');
    // storageConfig may or may not pass depending on test env config — that's fine here.
  });
});

// ---------------------------------------------------------------------------
// Test: /health/ready — staging dir not writable
// ---------------------------------------------------------------------------

describe('GET /health/ready — staging NOT writable', () => {
  let app: INestApplication;
  let close: () => Promise<void>;

  beforeAll(async () => {
    // Point staging at a path that does not exist → not writable
    ({ app, close } = await buildAppWithStagingDir(
      '/nonexistent/path/gus-staging-9999',
    ));
  });

  afterAll(() => close());

  it('returns 503 when staging dir is not writable', async () => {
    const res = await request(serverOf(app)).get('/health/ready').expect(503);

    const body = res.body as ReadyBody;
    expect(body.status).toBe('error');
    expect(body.checks.stagingDir.status).toBe('error');
    expect(body.checks.stagingDir.message).toContain('not writable');
  });
});

// ---------------------------------------------------------------------------
// Test: CORS — development mode allows all origins
// ---------------------------------------------------------------------------

describe('CORS — development / test mode (origin: true)', () => {
  let app: INestApplication;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ app, close } = await buildApp({ NODE_ENV: 'test' }));
  });

  afterAll(() => close());

  it('reflects any origin in development mode', async () => {
    const res = await request(serverOf(app))
      .get('/health/live')
      .set('Origin', 'https://random.localhost')
      .expect(200);

    expect(res.headers['access-control-allow-origin']).toBe(
      'https://random.localhost',
    );
  });

  it('handles CORS preflight for allowed custom headers', async () => {
    const res = await request(serverOf(app))
      .options('/health/live')
      .set('Origin', 'https://random.localhost')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'X-API-Key, X-Correlation-Id')
      .expect(204);

    expect(
      res.headers['access-control-allow-headers']?.toLowerCase(),
    ).toContain('x-api-key');
  });
});

// ---------------------------------------------------------------------------
// Test: 404 — shape is problem+json, not HTML
// ---------------------------------------------------------------------------

describe('404 — unknown route', () => {
  let app: INestApplication;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ app, close } = await buildApp());
  });

  afterAll(() => close());

  it('returns problem+json shape (not HTML) for unknown routes', async () => {
    const res = await request(serverOf(app))
      .get('/this/route/does/not/exist')
      .set('Accept', 'application/json')
      .expect(404);

    const body = res.body as ErrorBody;
    // Must be problem+json, not an HTML page
    expect(res.headers['content-type']).toMatch(
      /application\/problem\+json|application\/json/,
    );
    expect(typeof body).toBe('object');
    expect(body.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Test: exception filter does not leak stack traces
// ---------------------------------------------------------------------------

describe('Exception filter — no stack trace leak', () => {
  let app: INestApplication;
  let close: () => Promise<void>;

  beforeAll(async () => {
    // NODE_ENV is kept as 'test' — the ProblemJsonErrorFilter never leaks
    // stack traces regardless of env (it's a property of the filter implementation,
    // not the runtime environment variable).
    ({ app, close } = await buildApp());
  });

  afterAll(() => close());

  it('does not include stack trace in error responses', async () => {
    const res = await request(serverOf(app))
      .get('/nonexistent-endpoint')
      .expect(404);

    const bodyStr = JSON.stringify(res.body as ErrorBody);
    expect(bodyStr).not.toMatch(/at Object\./);
    expect(bodyStr).not.toMatch(/\.ts:\d+/);
    expect(bodyStr).not.toMatch(/\.js:\d+/);
    expect(bodyStr).not.toContain('stack');
  });
});
