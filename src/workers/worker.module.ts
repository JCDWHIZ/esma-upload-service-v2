import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { DatabaseModule } from '../db/database.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { EventsModule } from '../events/events.module.js';
import { IngestModule } from '../ingest/ingest.module.js';
import { WorkerService } from './worker.service.js';
import { ReplicationWorker } from './replication.worker.js';
import { ScanWorker } from './scan.worker.js';
import { SweeperService } from './sweeper.service.js';
import { DlqWorker } from './dlq.worker.js';
import { ProcessingWorker } from './processing.worker.js';

@Module({
  imports: [
    ConfigModule,
    ObservabilityModule,
    DatabaseModule,
    StorageModule,
    EventsModule,
    IngestModule,
  ],
  providers: [
    WorkerService,
    ReplicationWorker,
    ScanWorker,
    ProcessingWorker,
    SweeperService,
    DlqWorker,
  ],
  exports: [
    WorkerService,
    ReplicationWorker,
    ScanWorker,
    ProcessingWorker,
    SweeperService,
    DlqWorker,
  ],
})
export class WorkerModule {}
