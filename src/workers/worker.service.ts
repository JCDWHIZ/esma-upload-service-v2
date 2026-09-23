import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { StructuredLogger } from '../observability/logger.service.js';
import { DatabaseService } from '../db/database.service.js';

@Injectable()
export class WorkerService implements OnApplicationBootstrap {
  constructor(
    private readonly logger: StructuredLogger,
    private readonly db: DatabaseService,
  ) {}

  async onApplicationBootstrap() {
    this.logger.log('Worker application context initialized');
    await this.db.ping();
  }
}
