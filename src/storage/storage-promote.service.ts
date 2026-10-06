import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../db/database.service.js';
import type { Provider } from '../core/types.js';

export interface StoragePromoteOptions {
  toProvider: Provider;
  fromProvider?: Provider;
  namespace?: string;
  batchSize?: number;
  dryRun?: boolean;
}

export interface StoragePromoteResult {
  scanned: number;
  promoted: number;
  skippedNotAvailable: number;
  alreadyPrimary: number;
  errors: number;
}

@Injectable()
export class StoragePromoteService {
  private readonly logger = new Logger(StoragePromoteService.name);

  constructor(private readonly db: DatabaseService) {}

  async promotePrimary(
    options: StoragePromoteOptions,
  ): Promise<StoragePromoteResult> {
    const database = this.db.getDb();
    if (!database) {
      throw new Error('Database service is not connected');
    }

    const {
      toProvider,
      fromProvider,
      namespace,
      batchSize = 100,
      dryRun = false,
    } = options;

    this.logger.log(
      `Starting storage promotion to provider "${toProvider}"` +
        (fromProvider ? ` from "${fromProvider}"` : '') +
        (namespace ? ` in namespace "${namespace}"` : '') +
        (dryRun ? ' [DRY-RUN]' : ''),
    );

    const result: StoragePromoteResult = {
      scanned: 0,
      promoted: 0,
      skippedNotAvailable: 0,
      alreadyPrimary: 0,
      errors: 0,
    };

    let lastId: string | null = null;
    let hasMore = true;

    while (hasMore) {
      let query = database
        .selectFrom('files')
        .select(['id', 'primary_provider', 'namespace'])
        .where('status', '=', 'ACTIVE');

      if (fromProvider) {
        query = query.where('primary_provider', '=', fromProvider);
      } else {
        query = query.where('primary_provider', '!=', toProvider);
      }

      if (namespace) {
        query = query.where('namespace', '=', namespace);
      }

      if (lastId) {
        query = query.where('id', '>', lastId);
      }

      const files = await query.orderBy('id', 'asc').limit(batchSize).execute();

      if (files.length === 0) {
        hasMore = false;
        break;
      }

      lastId = files[files.length - 1].id;

      for (const file of files) {
        result.scanned++;

        try {
          if (file.primary_provider === toProvider) {
            result.alreadyPrimary++;
            continue;
          }

          const replicas = await database
            .selectFrom('file_replicas')
            .select(['provider', 'role', 'status'])
            .where('file_id', '=', file.id)
            .execute();

          const targetReplica = replicas.find((r) => r.provider === toProvider);

          if (!targetReplica || targetReplica.status !== 'AVAILABLE') {
            result.skippedNotAvailable++;
            continue;
          }

          if (dryRun) {
            this.logger.log(
              `[DRY-RUN] Would promote file ${file.id} (ns: ${file.namespace}) primary from "${file.primary_provider}" to "${toProvider}"`,
            );
            result.promoted++;
          } else {
            await database.transaction().execute(async (trx) => {
              // 1. Demote current primary replica to secondary
              await trx
                .updateTable('file_replicas')
                .set({
                  role: 'secondary',
                  updated_at: new Date(),
                })
                .where('file_id', '=', file.id)
                .where('role', '=', 'primary')
                .execute();

              // 2. Promote target replica to primary
              await trx
                .updateTable('file_replicas')
                .set({
                  role: 'primary',
                  updated_at: new Date(),
                })
                .where('file_id', '=', file.id)
                .where('provider', '=', toProvider)
                .execute();

              // 3. Update primary_provider on files table
              await trx
                .updateTable('files')
                .set({
                  primary_provider: toProvider,
                  updated_at: new Date(),
                })
                .where('id', '=', file.id)
                .execute();
            });

            result.promoted++;
          }
        } catch (err: unknown) {
          result.errors++;
          this.logger.error(
            `Failed to promote primary for file ${file.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (files.length < batchSize) {
        hasMore = false;
      }
    }

    this.logger.log(
      `Storage promotion finished: scanned=${result.scanned}, promoted=${result.promoted}, ` +
        `skippedNotAvailable=${result.skippedNotAvailable}, alreadyPrimary=${result.alreadyPrimary}, errors=${result.errors}`,
    );

    return result;
  }
}
