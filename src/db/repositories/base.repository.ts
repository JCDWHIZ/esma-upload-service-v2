import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../types.js';
import { KYSELY_DB } from '../constants.js';

@Injectable()
export abstract class BaseRepository {
  constructor(
    @Optional()
    @Inject(KYSELY_DB)
    protected readonly defaultDb?: Kysely<Database>,
  ) {}

  protected getExecutor(
    trx?: Transaction<Database> | Kysely<Database>,
  ): Transaction<Database> | Kysely<Database> {
    const executor = trx ?? this.defaultDb;
    if (!executor) {
      throw new Error(
        'Database connection is not initialized or database access is disabled.',
      );
    }
    return executor;
  }
}
