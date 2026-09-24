import { Pool } from 'pg';
import { type Kysely } from 'kysely';
import type { Database } from '../../src/db/types.js';
import { createKysely } from '../../src/db/kysely.js';
import { closePgPool, createPgPool } from '../../src/db/pool.js';

export interface TestDatabaseContext {
  pool: Pool;
  db: Kysely<Database>;
  connectionString: string;
  cleanup: () => Promise<void>;
}

interface ContainerInstance {
  getConnectionUri(): string;
  stop(): Promise<void>;
}

/**
 * Creates an isolated test database context.
 * In Docker-enabled environments (such as CI), it can use @testcontainers/postgresql.
 * In local environments without Docker, it connects to PostgreSQL and creates an isolated schema.
 */
export async function createTestDatabase(): Promise<TestDatabaseContext> {
  const fallbackUrl =
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    'postgres://postgres:root@localhost:5432/esma-upload';

  let container: ContainerInstance | undefined;
  let connectionString = fallbackUrl;
  let schemaName: string | null = null;

  // Try Testcontainers if explicitly requested or if DOCKER_HOST is set
  if (process.env.USE_TESTCONTAINERS === 'true') {
    try {
      const { PostgreSqlContainer } =
        await import('@testcontainers/postgresql');
      const started = await new PostgreSqlContainer(
        'postgres:17-alpine',
      ).start();
      container = started as unknown as ContainerInstance;
      connectionString = container.getConnectionUri();
    } catch {
      // Fallback to local postgres connection string
      connectionString = fallbackUrl;
    }
  }

  // Create isolated schema when using shared local database
  if (!container) {
    const randomSuffix = Math.random().toString(36).substring(2, 9);
    schemaName = `test_schema_${Date.now()}_${randomSuffix}`;

    const adminPool = createPgPool({ connectionString, max: 2 });
    try {
      await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    } finally {
      await closePgPool(adminPool);
    }
  }

  // Create test pool with search_path set to isolated schema if applicable
  const pool = new Pool({
    connectionString,
    max: 5,
    statement_timeout: 10000,
    options: schemaName ? `-c search_path=${schemaName},public` : undefined,
  });

  const db = createKysely(pool);

  const cleanup = async () => {
    try {
      await db.destroy();
    } catch {
      // ignore
    }

    try {
      await closePgPool(pool);
    } catch {
      // ignore
    }

    if (schemaName) {
      const adminPool = createPgPool({ connectionString, max: 2 });
      try {
        await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      } catch {
        // ignore
      } finally {
        await closePgPool(adminPool);
      }
    }

    if (container) {
      try {
        await container.stop();
      } catch {
        // ignore
      }
    }
  };

  return {
    pool,
    db,
    connectionString,
    cleanup,
  };
}
