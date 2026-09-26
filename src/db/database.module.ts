import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service.js';

export const PG_POOL = 'PG_POOL';
export const KYSELY_DB = 'KYSELY_DB';

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
  ],
  exports: [DatabaseService, PG_POOL, KYSELY_DB],
})
export class DatabaseModule {}
