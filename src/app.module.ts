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
  ],
})
export class AppModule {}
