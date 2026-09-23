import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { AppConfigService } from './config/config.service.js';
import { StructuredLogger } from './observability/logger.service.js';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  const config = app.get(AppConfigService);
  const logger = app.get(StructuredLogger);
  app.useLogger(logger);

  // Security middlewares
  app.use(helmet());
  app.set('trust proxy', config.trustProxy);

  // Global filters
  app.useGlobalFilters(new GlobalExceptionFilter());

  // Swagger OpenAPI Documentation
  if (config.swaggerEnabled || !config.isProduction()) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('ESMA Upload Service (v2)')
      .setDescription('Modern Generic Upload Service API')
      .setVersion('2.0')
      .addBearerAuth()
      .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, 'api-key')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
  }

  await app.listen(config.port);
  logger.log(`ESMA Upload Service API listening on port ${config.port}`);
}

bootstrap().catch((err) => {
  console.error('Fatal error during API bootstrap', err);
  process.exit(1);
});
