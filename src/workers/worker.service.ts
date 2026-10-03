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

@Injectable()
export class WorkerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  constructor(
    private readonly logger: StructuredLogger,
    private readonly db: DatabaseService,
    private readonly configService: AppConfigService,
    private readonly outboxRelay: OutboxRelay,
    private readonly outboxRetention: OutboxRetentionService,
  ) {}

  async onApplicationBootstrap() {
    this.logger.log('Worker application context initialized');
    await this.db.ping();

    const roles = this.configService.workerRoles
      .split(',')
      .map((r) => r.trim().toLowerCase());

    if (roles.includes('relay')) {
      this.logger.log(
        'Starting relay role: OutboxRelay and OutboxRetentionService',
      );
      await this.outboxRelay.start();
      this.outboxRetention.start();
    }
  }

  onApplicationShutdown(signal?: string) {
    this.logger.log(`Worker shutdown signal: ${signal ?? 'none'}`);
    this.outboxRelay.stop();
    this.outboxRetention.stop();
  }
}
