import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { DatabaseModule } from './db/database.module.js';
import { StorageModule } from './storage/storage.module.js';
import { EventsModule } from './events/events.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AuthorizationModule } from './authz/authorization.module.js';
import { IngestModule } from './ingest/ingest.module.js';
import { FilesModule } from './files/files.module.js';
import { AdminModule } from './admin/admin.module.js';
import { WorkerModule } from './workers/worker.module.js';

@Module({
  imports: [
    ConfigModule,
    ObservabilityModule,
    DatabaseModule,
    StorageModule,
    EventsModule,
    AuthModule,
    AuthorizationModule,
    IngestModule,
    FilesModule,
    AdminModule,
    ...(process.env.EMBEDDED_WORKER === 'true' ? [WorkerModule] : []),
  ],
})
export class AppModule {}
