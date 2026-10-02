import {
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { StructuredLogger } from '../observability/logger.service.js';
import { DatabaseService } from '../db/database.service.js';
import { AppConfigService } from '../config/config.service.js';
import { OutboxRelay } from '../events/outbox-relay.js';
import { OutboxRetentionService } from '../events/outbox-retention.service.js';
import { ReplicationWorker } from './replication.worker.js';
import { ScanWorker } from './scan.worker.js';
import { SweeperService } from './sweeper.service.js';
import { DlqWorker } from './dlq.worker.js';
import { ProcessingWorker } from './processing.worker.js';

@Injectable()
export class WorkerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly runningRoles = new Set<string>();

  constructor(
    private readonly logger: StructuredLogger,
    private readonly db: DatabaseService,
    private readonly configService: AppConfigService,
    private readonly outboxRelay: OutboxRelay,
    private readonly outboxRetention: OutboxRetentionService,
    private readonly replicationWorker: ReplicationWorker,
    private readonly scanWorker: ScanWorker,
    private readonly processingWorker: ProcessingWorker,
    private readonly sweeperService: SweeperService,
    private readonly dlqWorker: DlqWorker,
  ) {}

  async onApplicationBootstrap() {
    this.logger.log('Worker application context initialized');
    await this.db.ping();
    await this.startConfiguredRoles();
  }

  async startConfiguredRoles(): Promise<void> {
    const roles = this.configService.workerRoles
      .split(',')
      .map((r) => r.trim().toLowerCase());

    if (roles.includes('relay') && !this.runningRoles.has('relay')) {
      this.logger.log(
        'Starting relay role: OutboxRelay and OutboxRetentionService',
      );
      await this.outboxRelay.start();
      this.outboxRetention.start();
      this.runningRoles.add('relay');
    }

    if (
      roles.includes('replication') &&
      !this.runningRoles.has('replication')
    ) {
      this.logger.log('Starting replication role: ReplicationWorker');
      await this.replicationWorker.start();
      this.runningRoles.add('replication');
    }

    if (roles.includes('processing') && !this.runningRoles.has('processing')) {
      this.logger.log(
        'Starting processing role: ScanWorker and ProcessingWorker',
      );
      await this.scanWorker.start();
      await this.processingWorker.start();
      this.runningRoles.add('processing');
    }

    if (roles.includes('sweeper') && !this.runningRoles.has('sweeper')) {
      this.logger.log('Starting sweeper role: SweeperService');
      this.sweeperService.start();
      this.runningRoles.add('sweeper');
    }

    if (roles.includes('dlq') && !this.runningRoles.has('dlq')) {
      this.logger.log('Starting dlq role: DlqWorker');
      await this.dlqWorker.start();
      this.runningRoles.add('dlq');
    }
  }

  async stopRoles(): Promise<void> {
    if (this.runningRoles.has('relay')) {
      this.outboxRelay.stop();
      this.outboxRetention.stop();
      this.runningRoles.delete('relay');
    }
    if (this.runningRoles.has('replication')) {
      await this.replicationWorker.stop();
      this.runningRoles.delete('replication');
    }
    if (this.runningRoles.has('processing')) {
      await this.scanWorker.stop();
      await this.processingWorker.stop();
      this.runningRoles.delete('processing');
    }
    if (this.runningRoles.has('sweeper')) {
      this.sweeperService.stop();
      this.runningRoles.delete('sweeper');
    }
    if (this.runningRoles.has('dlq')) {
      await this.dlqWorker.stop();
      this.runningRoles.delete('dlq');
    }
    this.runningRoles.clear();
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Worker shutdown signal: ${signal ?? 'none'}`);
    await this.stopRoles();
  }

  getRunningRoles(): string[] {
    return Array.from(this.runningRoles);
  }
}
