import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { AppConfigService } from './config/config.service.js';
import { StructuredLogger } from './observability/logger.service.js';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter.js';

// Graceful shutdown drain window (ms). Keep shorter than any load-balancer
// connection drain timeout (typically 30 s) so the LB removes the instance
// before we hard-kill in-flight requests.
const SHUTDOWN_DRAIN_MS = 25_000;

// Server timeout values (ms). headersTimeout and keepAliveTimeout must exceed
// any upstream proxy/load-balancer idle timeout (commonly 60 s → we use 65 s).
const HEADERS_TIMEOUT_MS = 65_000;
const REQUEST_TIMEOUT_MS = 60_000;
const KEEPALIVE_TIMEOUT_MS = 65_000;

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  const config = app.get(AppConfigService);
  const logger = app.get(StructuredLogger);
  app.useLogger(logger);

  // ── Base Path / Global Prefix ───────────────────────────────────────────────
  const rawBasePath = config.basePath ?? '/uploads';
  const basePath = rawBasePath.replace(/^\/+|\/+$/g, '');
  if (basePath) {
    app.setGlobalPrefix(basePath);
    logger.log(`Application base path configured at /${basePath}`);

    // Internal compatibility rewrite: allow probes/clients hitting /health/*,
    // /metrics, or /docs directly to resolve to /${basePath}/* seamlessly.
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

  // ── Helmet ──────────────────────────────────────────────────────────────────
  // Apply strict defaults everywhere. The Swagger UI needs inline
  // scripts and CDN assets from cdn.jsdelivr.net, so we relax CSP only for
  // that path via a route-scoped middleware.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: [],
        },
      },
    }),
  );

  // Relax CSP only on the Swagger docs route (both prefixed and un-prefixed)
  const docsUrlPattern = basePath ? `/${basePath}/docs` : '/docs';
  app.use(
    [docsUrlPattern, '/docs'],
    (req: Request, res: Response, next: NextFunction) => {
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net'],
            styleSrc: ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net'],
            imgSrc: ["'self'", 'data:', 'cdn.jsdelivr.net'],
            objectSrc: ["'none'"],
          },
        },
      })(req, res, next);
    },
  );

  // ── Trust proxy ─────────────────────────────────────────────────────────────
  app.set('trust proxy', config.trustProxy);

  // ── CORS ────────────────────────────────────────────────────────────────────
  // In production, only origins on the allowlist get CORS headers; no wildcard.
  // In development, all origins are allowed so local frontends work out of the box.
  const allowedOrigins = config.corsAllowedOrigins
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: config.isProduction() ? allowedOrigins : true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-API-Key',
      'X-Correlation-Id',
      'X-School-Id',
      'X-Branch-Id',
      'X-Tenant-Id',
      'X-Namespace',
      'X-Sub-Tenant-Id',
    ],
    exposedHeaders: ['X-Correlation-Id'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
    credentials: true,
    maxAge: 86_400, // 24 h preflight cache
  });

  // ── Body size limits ─────────────────────────────────────────────────────────
  // Limit raw JSON and URL-encoded bodies.  File uploads are handled by multer
  // in IngestModule and have their own per-policy limits.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // ── Global exception filter ───────────────────────────────────────────────
  app.useGlobalFilters(new GlobalExceptionFilter());

  // ── Swagger ───────────────────────────────────────────────────────────────
  // Refuse to start if Swagger is enabled in production without an admin gate.
  if (config.isProduction() && config.swaggerEnabled) {
    if (config.adminAuthMode === 'off') {
      logger.error(
        'Refusing to start: SWAGGER_ENABLED=true in production requires ' +
          'ADMIN_AUTH_MODE to be "report" or "enforce". ' +
          'Set SWAGGER_ENABLED=false or configure an admin auth mode.',
      );
      process.exit(1);
    }
  }

  if (config.swaggerEnabled || !config.isProduction()) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('ESMA Upload Service (v2)')
      .setDescription('File upload and delivery API')
      .setVersion('2.0')
      .addBearerAuth()
      .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, 'api-key')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    const swaggerPath = basePath ? `${basePath}/docs` : 'docs';
    SwaggerModule.setup(swaggerPath, app, document);
    logger.log(`Swagger UI available at /${swaggerPath}`);
  }

  // ── Start HTTP server ─────────────────────────────────────────────────────
  await app.listen(config.port);
  logger.log(`ESMA Upload Service API listening on port ${config.port}`);

  // ── Server timeouts ───────────────────────────────────────────────────────
  // Set after listen() so the underlying server is available.
  const httpServer = app.getHttpServer();
  httpServer.headersTimeout = HEADERS_TIMEOUT_MS;
  httpServer.requestTimeout = REQUEST_TIMEOUT_MS;
  httpServer.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;

  // ── Graceful shutdown (SIGTERM) ───────────────────────────────────────────
  // 1. Stop accepting new connections.
  // 2. Wait up to SHUTDOWN_DRAIN_MS for in-flight requests to finish.
  // 3. Close the Nest application context (DB pool, etc.) and exit cleanly.
  process.once('SIGTERM', () => {
    logger.log('SIGTERM received — starting graceful shutdown');

    httpServer.close(() => {
      logger.log('HTTP server closed — no more connections accepted');
    });

    // Hard exit after the drain window if requests have not finished.
    const drainTimer = setTimeout(() => {
      logger.warn(
        `Graceful drain exceeded ${SHUTDOWN_DRAIN_MS} ms — forcing exit`,
      );
      process.exit(1);
    }, SHUTDOWN_DRAIN_MS);

    // Allow the timer to be unblocked by the normal app.close() path.
    if (typeof drainTimer.unref === 'function') {
      drainTimer.unref();
    }

    void app.close().then(() => {
      logger.log('Application context closed — exiting');
      clearTimeout(drainTimer);
      process.exit(0);
    });
  });
}

bootstrap().catch((err: unknown) => {
  process.stderr.write(`Fatal error during API bootstrap: ${String(err)}\n`);
  process.exit(1);
});
