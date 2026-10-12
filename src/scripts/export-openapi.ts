import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppModule } from '../app.module.js';

async function exportOpenApi() {
  process.env.DB_ENABLED = 'false';
  process.env.EVENTS_ENABLED = 'false';
  process.env.STORAGE_DRIVER_PRIMARY = 'local';
  process.env.LOCAL_STORAGE_DIR = './tmp';

  const app = await NestFactory.create(AppModule, { logger: false });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('ESMA Upload Service (v2)')
    .setDescription('File upload and delivery API')
    .setVersion('2.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, 'api-key')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);

  const outDir = path.resolve(process.cwd(), 'openapi');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const outFile = path.join(outDir, 'esma-upload-v1.json');
  fs.writeFileSync(outFile, JSON.stringify(document, null, 2), 'utf8');
  console.log(`OpenAPI specification exported successfully to ${outFile}`);

  await app.close();
}

exportOpenApi().catch((err) => {
  console.error('Failed to export OpenAPI specification:', err);
  process.exit(1);
});
