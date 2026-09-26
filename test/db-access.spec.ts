import { sql } from 'kysely';
import { createPgPool, closePgPool } from '../src/db/pool.js';
import { createKysely, withTransaction } from '../src/db/kysely.js';
import {
  runMigrations,
  getMigrationStatus,
  MIGRATION_LOCK_ID,
} from '../src/db/migrate.js';
import { DatabaseService } from '../src/db/database.service.js';
import { AppConfigService } from '../src/config/config.service.js';
import {
  createTestDatabase,
  type TestDatabaseContext,
} from './helpers/db-test-helper.js';

describe('PostgreSQL Access Layer & Migration Runner (P1-04)', () => {
  let testCtx: TestDatabaseContext;

  beforeAll(async () => {
    testCtx = await createTestDatabase();
  });

  afterAll(async () => {
    if (testCtx) {
      await testCtx.cleanup();
    }
  });

  describe('Pool & Kysely connectivity', () => {
    it('should connect, execute queries and return valid rows', async () => {
      const result = await sql<{ sum: number }>`SELECT 1 + 1 AS sum`.execute(
        testCtx.db,
      );
      expect(result.rows).toHaveLength(1);
      expect(Number(result.rows[0].sum)).toBe(2);
    });

    it('should handle idle pool errors gracefully without unhandled process termination', () => {
      const pool = createPgPool({
        connectionString: testCtx.connectionString,
        max: 2,
      });

      // Emit simulated error on pool
      expect(() => {
        pool.emit('error', new Error('Simulated pool socket timeout'));
      }).not.toThrow();

      return closePgPool(pool);
    });
  });

  describe('withTransaction helper', () => {
    beforeAll(async () => {
      // Create a scratch table inside the test schema
      await sql`CREATE TABLE IF NOT EXISTS test_tx_items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`.execute(
        testCtx.db,
      );
    });

    afterAll(async () => {
      await sql`DROP TABLE IF EXISTS test_tx_items`.execute(testCtx.db);
    });

    it('should commit operations when transaction callback succeeds', async () => {
      await withTransaction(testCtx.db, async (trx) => {
        await sql`INSERT INTO test_tx_items (name) VALUES ('committed_item')`.execute(
          trx,
        );
      });

      const res = await sql<{
        count: string;
      }>`SELECT count(*) AS count FROM test_tx_items WHERE name = 'committed_item'`.execute(
        testCtx.db,
      );
      expect(Number(res.rows[0].count)).toBe(1);
    });

    it('should rollback operations when transaction callback throws', async () => {
      await expect(
        withTransaction(testCtx.db, async (trx) => {
          await sql`INSERT INTO test_tx_items (name) VALUES ('rolled_back_item')`.execute(
            trx,
          );
          throw new Error('Forced rollback error');
        }),
      ).rejects.toThrow('Forced rollback error');

      const res = await sql<{
        count: string;
      }>`SELECT count(*) AS count FROM test_tx_items WHERE name = 'rolled_back_item'`.execute(
        testCtx.db,
      );
      expect(Number(res.rows[0].count)).toBe(0);
    });
  });

  describe('Migration runner & advisory locking', () => {
    it('should execute migrations and be idempotent', async () => {
      const results1 = await runMigrations(testCtx.db);
      expect(Array.isArray(results1)).toBe(true);

      // Second run should also succeed without error
      const results2 = await runMigrations(testCtx.db);
      expect(Array.isArray(results2)).toBe(true);
      expect(results2).toHaveLength(0); // already up to date
    });

    it('should report migration status via getMigrationStatus', async () => {
      const status = await getMigrationStatus(testCtx.db);
      expect(Array.isArray(status)).toBe(true);
    });

    it('should serialize concurrent migration runners with advisory lock', async () => {
      // Create a separate connection pool to act as a second concurrent client
      const secondPool = createPgPool({
        connectionString: testCtx.connectionString,
        max: 2,
      });
      const secondDb = createKysely(secondPool);

      try {
        // First connection explicitly holds the advisory lock
        await sql`SELECT pg_advisory_lock(${sql.lit(MIGRATION_LOCK_ID)}::bigint)`.execute(
          testCtx.db,
        );

        // Second connection attempts to run migrations without lock wait -> should be rejected
        await expect(
          runMigrations(secondDb, { allowLockWait: false }),
        ).rejects.toThrow('Could not acquire migration advisory lock');
      } finally {
        await sql`SELECT pg_advisory_unlock(${sql.lit(MIGRATION_LOCK_ID)}::bigint)`.execute(
          testCtx.db,
        );
        await secondDb.destroy();
        await closePgPool(secondPool);
      }
    });
  });

  describe('DatabaseService & Readiness checks', () => {
    it('should return true on ping when DB_ENABLED=false', async () => {
      const config = new AppConfigService({ DB_ENABLED: 'false' });
      const service = new DatabaseService(config);

      const pingResult = await service.ping();
      expect(pingResult).toBe(true);
      expect(service.getPool()).toBeUndefined();
    });

    it('should return true on ping when DB_ENABLED=true and connection is valid', async () => {
      const config = new AppConfigService({
        DB_ENABLED: 'true',
        DATABASE_URL: testCtx.connectionString,
      });
      const service = new DatabaseService(config);
      service.onModuleInit();

      const pingResult = await service.ping();
      expect(pingResult).toBe(true);
      expect(service.getPool()).toBeDefined();

      await service.onApplicationShutdown();
    });

    it('should return false on ping when DB_ENABLED=true and connection is unreachable', async () => {
      const config = new AppConfigService({
        DB_ENABLED: 'true',
        DATABASE_URL:
          'postgres://invalid_user:invalid_pass@127.0.0.1:54329/nonexistent',
      });
      const service = new DatabaseService(config);
      service.onModuleInit();

      const pingResult = await service.ping();
      expect(pingResult).toBe(false);

      await service.onApplicationShutdown();
    });
  });
});
