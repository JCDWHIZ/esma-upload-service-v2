try {
  process.loadEnvFile();
} catch {
  // Ignore error if .env file is not present
}

import * as http from 'node:http';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './workers/worker.module.js';
import { StructuredLogger } from './observability/logger.service.js';
import { AppConfigService } from './config/config.service.js';
import { HealthService } from './observability/health.service.js';
import { WorkerService } from './workers/worker.service.js';

export function createWorkerHealthServer(
  healthService: HealthService,
  port: number,
  logger: StructuredLogger,
): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = req.url?.split('?')[0] ?? '/';

      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }

      if (url === '/health/live' || url === '/live') {
        const liveStatus = healthService.live();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(liveStatus));
        return;
      }

      if (url === '/health/ready' || url === '/ready') {
        const readyStatus = await healthService.ready();
        const statusCode = readyStatus.status === 'ok' ? 200 : 503;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(readyStatus));
        return;
      }

      if (url === '/health/drivers' || url === '/drivers') {
        const driversStatus = healthService.drivers();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(driversStatus));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    })();
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      logger.log(`Worker health server listening on port ${port}`);
      resolve(server);
    });
  });
}

export async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });

  const logger = app.get(StructuredLogger);
  app.useLogger(logger);

  const config = app.get(AppConfigService);
  const healthService = app.get(HealthService);
  const workerService = app.get(WorkerService);

  logger.log(
    `ESMA Upload Service Worker process started (roles: ${config.workerRoles})`,
  );

  let healthServer: http.Server | null = null;
  try {
    healthServer = await createWorkerHealthServer(
      healthService,
      config.workerHealthPort,
      logger,
    );
  } catch (err: unknown) {
    logger.warn(
      `Failed to start worker health server on port ${config.workerHealthPort}: ${String(err)}`,
    );
  }

  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.log(`Received ${signal}, gracefully shutting down worker...`);

    if (healthServer) {
      await new Promise<void>((resolve) => {
        healthServer?.close(() => resolve());
      });
    }

    await workerService.stopRoles();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  return { app, healthServer };
}

// Only invoke automatically when run as the primary module
if (
  process.argv[1] &&
  (process.argv[1].endsWith('worker.js') ||
    process.argv[1].endsWith('worker.ts'))
) {
  bootstrap().catch((err: unknown) => {
    process.stderr.write(
      `Fatal error during worker bootstrap: ${String(err)}\n`,
    );
    process.exit(1);
  });
}
