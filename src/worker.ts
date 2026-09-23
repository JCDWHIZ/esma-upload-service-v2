import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './workers/worker.module.js';
import { StructuredLogger } from './observability/logger.service.js';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });

  const logger = app.get(StructuredLogger);
  app.useLogger(logger);

  logger.log('ESMA Upload Service Worker process started');

  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal}, gracefully shutting down worker...`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

bootstrap().catch((err: unknown) => {
  console.error('Fatal error during worker bootstrap', err);
  process.exit(1);
});
