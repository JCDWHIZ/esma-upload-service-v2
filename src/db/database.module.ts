import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import {
  FileRepository,
  ReplicaRepository,
  OutboxRepository,
  AuditRepository,
  ApiClientRepository,
  UsageRepository,
  ProcessedEventsRepository,
} from './repositories/index.js';

export const PG_POOL = 'PG_POOL';
export const KYSELY_DB = 'KYSELY_DB';

const repositories = [
  FileRepository,
  ReplicaRepository,
  OutboxRepository,
  AuditRepository,
  ApiClientRepository,
  UsageRepository,
  ProcessedEventsRepository,
];

@Global()
@Module({
  providers: [
    DatabaseService,
    {
      provide: PG_POOL,
      useFactory: (dbService: DatabaseService) => dbService.getPool(),
      inject: [DatabaseService],
    },
    {
      provide: KYSELY_DB,
      useFactory: (dbService: DatabaseService) => dbService.getDb(),
      inject: [DatabaseService],
    },
    ...repositories,
  ],
  exports: [DatabaseService, PG_POOL, KYSELY_DB, ...repositories],
})
export class DatabaseModule {}
