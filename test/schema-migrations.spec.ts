import { v4 as uuidv4 } from 'uuid';
import {
  createTestDatabase,
  type TestDatabaseContext,
} from './helpers/db-test-helper.js';
import { runMigrations, getMigrationStatus } from '../src/db/migrate.js';

describe('P1-05 Schema Migrations & Constraints', () => {
  let ctx: TestDatabaseContext;

  beforeAll(async () => {
    ctx = await createTestDatabase();
  });

  afterAll(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  it('migrates an empty database to the latest schema and is idempotent on rerun', async () => {
    const firstRun = await runMigrations(ctx.db, {
      allowLockWait: true,
      migrationTableSchema: ctx.schemaName,
    });
    expect(firstRun.length).toBe(6);
    for (const res of firstRun) {
      expect(res.status).toBe('Success');
    }

    const statusAfterFirst = await getMigrationStatus(ctx.db, {
      migrationTableSchema: ctx.schemaName,
    });
    expect(statusAfterFirst.length).toBe(6);
    for (const m of statusAfterFirst) {
      expect(m.executedAt).toBeDefined();
    }

    // Second run must be a no-op
    const secondRun = await runMigrations(ctx.db, {
      allowLockWait: true,
      migrationTableSchema: ctx.schemaName,
    });
    expect(secondRun.length).toBe(0);
  });

  describe('Table CHECK constraints', () => {
    const validFileId = uuidv4();

    it('enforces size_bytes >= 0 on files table', async () => {
      // Valid insert
      await ctx.db
        .insertInto('files')
        .values({
          id: validFileId,
          namespace: 'esma-tenant',
          tenant_id: 'school-1',
          folder: 'documents',
          storage_key: 'esma-tenant/school-1/doc.pdf',
          original_filename: 'doc.pdf',
          mimetype: 'application/pdf',
          size_bytes: 1024,
          visibility: 'tenant',
          primary_provider: 'local',
          uploaded_by: 'user-1',
          correlation_id: 'corr-1',
        })
        .execute();

      // Negative size_bytes must be rejected
      await expect(
        ctx.db
          .insertInto('files')
          .values({
            id: uuidv4(),
            namespace: 'esma-tenant',
            tenant_id: 'school-1',
            folder: 'documents',
            storage_key: 'esma-tenant/school-1/doc2.pdf',
            original_filename: 'doc2.pdf',
            mimetype: 'application/pdf',
            size_bytes: -10,
            visibility: 'tenant',
            primary_provider: 'local',
            uploaded_by: 'user-1',
            correlation_id: 'corr-2',
          })
          .execute(),
      ).rejects.toThrow();
    });

    it('enforces visibility check constraint on files table', async () => {
      await expect(
        ctx.db
          .insertInto('files')
          .values({
            id: uuidv4(),
            namespace: 'esma-tenant',
            tenant_id: 'school-1',
            folder: '',
            storage_key: 'key-inv-vis',
            original_filename: 'test.jpg',
            mimetype: 'image/jpeg',
            size_bytes: 100,
            visibility: 'invalid_vis' as unknown as 'public',
            primary_provider: 'local',
            uploaded_by: 'user-1',
            correlation_id: 'corr-3',
          })
          .execute(),
      ).rejects.toThrow();
    });

    it('enforces status, scan_status, replication_status, and primary_provider on files table', async () => {
      await expect(
        ctx.db
          .insertInto('files')
          .values({
            id: uuidv4(),
            namespace: 'esma-tenant',
            tenant_id: 'school-1',
            folder: '',
            storage_key: 'key-inv-status',
            original_filename: 'test.jpg',
            mimetype: 'image/jpeg',
            size_bytes: 100,
            visibility: 'tenant',
            status: 'UNKNOWN_STATUS' as unknown as 'ACTIVE',
            primary_provider: 'local',
            uploaded_by: 'user-1',
            correlation_id: 'corr-4',
          })
          .execute(),
      ).rejects.toThrow();

      await expect(
        ctx.db
          .insertInto('files')
          .values({
            id: uuidv4(),
            namespace: 'esma-tenant',
            tenant_id: 'school-1',
            folder: '',
            storage_key: 'key-inv-scan',
            original_filename: 'test.jpg',
            mimetype: 'image/jpeg',
            size_bytes: 100,
            visibility: 'tenant',
            scan_status: 'UNKNOWN_SCAN' as unknown as 'PENDING',
            primary_provider: 'local',
            uploaded_by: 'user-1',
            correlation_id: 'corr-5',
          })
          .execute(),
      ).rejects.toThrow();

      await expect(
        ctx.db
          .insertInto('files')
          .values({
            id: uuidv4(),
            namespace: 'esma-tenant',
            tenant_id: 'school-1',
            folder: '',
            storage_key: 'key-inv-provider',
            original_filename: 'test.jpg',
            mimetype: 'image/jpeg',
            size_bytes: 100,
            visibility: 'tenant',
            primary_provider: 's3' as unknown as 'local',
            uploaded_by: 'user-1',
            correlation_id: 'corr-6',
          })
          .execute(),
      ).rejects.toThrow();
    });

    it('enforces check constraints on file_replicas', async () => {
      // Valid replica insert
      await ctx.db
        .insertInto('file_replicas')
        .values({
          file_id: validFileId,
          provider: 'local',
          role: 'primary',
          status: 'AVAILABLE',
          provider_key: 'local/path/key',
        })
        .execute();

      // Invalid provider
      await expect(
        ctx.db
          .insertInto('file_replicas')
          .values({
            file_id: validFileId,
            provider: 's3' as unknown as 'local',
            role: 'secondary',
            status: 'QUEUED',
            provider_key: 's3/path/key',
          })
          .execute(),
      ).rejects.toThrow();

      // Invalid role
      await expect(
        ctx.db
          .insertInto('file_replicas')
          .values({
            file_id: validFileId,
            provider: 'cloudinary',
            role: 'tertiary' as unknown as 'secondary',
            status: 'QUEUED',
            provider_key: 'cld/key',
          })
          .execute(),
      ).rejects.toThrow();

      // Invalid status
      await expect(
        ctx.db
          .insertInto('file_replicas')
          .values({
            file_id: validFileId,
            provider: 'seaweedfs',
            role: 'secondary',
            status: 'UNKNOWN_REPLICA' as unknown as 'QUEUED',
            provider_key: 'sw/key',
          })
          .execute(),
      ).rejects.toThrow();
    });

    it('enforces outcome check constraint on audit_log', async () => {
      await expect(
        ctx.db
          .insertInto('audit_log')
          .values({
            id: uuidv4(),
            action: 'FILE_UPLOAD',
            outcome: 'INVALID_OUTCOME' as unknown as 'SUCCESS',
            actor_id: 'user-1',
            actor_type: 'USER',
            namespace: 'esma-tenant',
            correlation_id: 'corr-audit',
          })
          .execute(),
      ).rejects.toThrow();
    });

    it('enforces status check constraint on api_clients', async () => {
      await expect(
        ctx.db
          .insertInto('api_clients')
          .values({
            id: uuidv4(),
            name: 'Test Client',
            key_prefix: 'pref_1',
            key_hash: 'hash_1',
            namespace: 'generic',
            scopes: ['files:read'],
            status: 'SUSPENDED' as unknown as 'ACTIVE',
          })
          .execute(),
      ).rejects.toThrow();
    });
  });

  describe('Indexes and Partial Unique Constraints', () => {
    it('behaves correctly for files_legacy_public_id_uq partial unique index', async () => {
      const publicId = 'legacy-pub-12345';

      // Insert first file with legacy_public_id
      await ctx.db
        .insertInto('files')
        .values({
          id: uuidv4(),
          namespace: 'esma-tenant',
          tenant_id: 'school-1',
          folder: '',
          storage_key: 'key-leg-1',
          original_filename: 'file1.pdf',
          mimetype: 'application/pdf',
          size_bytes: 100,
          visibility: 'tenant',
          primary_provider: 'local',
          uploaded_by: 'user-1',
          legacy_public_id: publicId,
          correlation_id: 'corr-leg-1',
        })
        .execute();

      // Insert second file with the same legacy_public_id must FAIL
      await expect(
        ctx.db
          .insertInto('files')
          .values({
            id: uuidv4(),
            namespace: 'esma-tenant',
            tenant_id: 'school-1',
            folder: '',
            storage_key: 'key-leg-2',
            original_filename: 'file2.pdf',
            mimetype: 'application/pdf',
            size_bytes: 200,
            visibility: 'tenant',
            primary_provider: 'local',
            uploaded_by: 'user-1',
            legacy_public_id: publicId,
            correlation_id: 'corr-leg-2',
          })
          .execute(),
      ).rejects.toThrow();

      // Multiple files with NULL legacy_public_id must SUCCEED
      await ctx.db
        .insertInto('files')
        .values([
          {
            id: uuidv4(),
            namespace: 'esma-tenant',
            tenant_id: 'school-1',
            folder: '',
            storage_key: 'key-leg-null-1',
            original_filename: 'file3.pdf',
            mimetype: 'application/pdf',
            size_bytes: 100,
            visibility: 'tenant',
            primary_provider: 'local',
            uploaded_by: 'user-1',
            legacy_public_id: null,
            correlation_id: 'corr-leg-null-1',
          },
          {
            id: uuidv4(),
            namespace: 'esma-tenant',
            tenant_id: 'school-1',
            folder: '',
            storage_key: 'key-leg-null-2',
            original_filename: 'file4.pdf',
            mimetype: 'application/pdf',
            size_bytes: 100,
            visibility: 'tenant',
            primary_provider: 'local',
            uploaded_by: 'user-1',
            legacy_public_id: null,
            correlation_id: 'corr-leg-null-2',
          },
        ])
        .execute();
    });

    it('behaves correctly for files_idem_uq partial unique index', async () => {
      const idemKey = 'idempotent-req-key-xyz';

      // Insert first row with idempotency key
      await ctx.db
        .insertInto('files')
        .values({
          id: uuidv4(),
          namespace: 'generic',
          tenant_id: 'tenant-a',
          folder: '',
          storage_key: 'key-idem-1',
          original_filename: 'idem1.pdf',
          mimetype: 'application/pdf',
          size_bytes: 100,
          visibility: 'tenant',
          primary_provider: 'local',
          uploaded_by: 'user-1',
          idempotency_key: idemKey,
          correlation_id: 'corr-idem-1',
        })
        .execute();

      // Same (namespace, tenant_id, idempotency_key) must FAIL
      await expect(
        ctx.db
          .insertInto('files')
          .values({
            id: uuidv4(),
            namespace: 'generic',
            tenant_id: 'tenant-a',
            folder: '',
            storage_key: 'key-idem-2',
            original_filename: 'idem2.pdf',
            mimetype: 'application/pdf',
            size_bytes: 100,
            visibility: 'tenant',
            primary_provider: 'local',
            uploaded_by: 'user-1',
            idempotency_key: idemKey,
            correlation_id: 'corr-idem-2',
          })
          .execute(),
      ).rejects.toThrow();

      // Different tenant with same idempotency_key must SUCCEED
      await ctx.db
        .insertInto('files')
        .values({
          id: uuidv4(),
          namespace: 'generic',
          tenant_id: 'tenant-b',
          folder: '',
          storage_key: 'key-idem-3',
          original_filename: 'idem3.pdf',
          mimetype: 'application/pdf',
          size_bytes: 100,
          visibility: 'tenant',
          primary_provider: 'local',
          uploaded_by: 'user-1',
          idempotency_key: idemKey,
          correlation_id: 'corr-idem-3',
        })
        .execute();
    });

    it('enforces api_clients key_prefix unique constraint', async () => {
      const prefix = `gus_pref_${Date.now().toString(36)}`;

      await ctx.db
        .insertInto('api_clients')
        .values({
          id: uuidv4(),
          name: 'Client 1',
          key_prefix: prefix,
          key_hash: 'hash_abc',
          namespace: 'generic',
          scopes: ['files:read', 'files:write'],
        })
        .execute();

      await expect(
        ctx.db
          .insertInto('api_clients')
          .values({
            id: uuidv4(),
            name: 'Client 2',
            key_prefix: prefix,
            key_hash: 'hash_xyz',
            namespace: 'generic',
            scopes: ['files:read'],
          })
          .execute(),
      ).rejects.toThrow();
    });
  });

  describe('Automatic updated_at triggers', () => {
    it('automatically updates updated_at timestamp upon update', async () => {
      const fileId = uuidv4();
      const pastTime = new Date('2020-01-01T00:00:00Z');

      await ctx.db
        .insertInto('files')
        .values({
          id: fileId,
          namespace: 'esma-tenant',
          tenant_id: 'school-1',
          folder: '',
          storage_key: 'key-trigger-test',
          original_filename: 'trigger.png',
          mimetype: 'image/png',
          size_bytes: 500,
          visibility: 'tenant',
          primary_provider: 'local',
          uploaded_by: 'user-1',
          correlation_id: 'corr-trigger',
          created_at: pastTime,
          updated_at: pastTime,
        })
        .execute();

      // Perform an update
      await ctx.db
        .updateTable('files')
        .set({ status: 'QUARANTINED' })
        .where('id', '=', fileId)
        .execute();

      const updatedRow = await ctx.db
        .selectFrom('files')
        .select(['updated_at', 'status'])
        .where('id', '=', fileId)
        .executeTakeFirstOrThrow();

      expect(updatedRow.status).toBe('QUARANTINED');
      const updatedTimestamp = new Date(updatedRow.updated_at).getTime();
      expect(updatedTimestamp).toBeGreaterThan(pastTime.getTime());
    });
  });

  describe('Audit role privileges enforcement (DB_APP_ROLE)', () => {
    it('restricts audit_log mutations for an application role', async () => {
      const randomRole = `test_app_role_${Date.now()}`;

      // Create a test role to simulate DB_APP_ROLE
      const client = await ctx.pool.connect();
      const schema = ctx.schemaName || 'public';
      try {
        await client.query(`CREATE ROLE "${randomRole}"`);
        await client.query(
          `GRANT USAGE ON SCHEMA "${schema}" TO "${randomRole}"`,
        );

        // Apply the audit privileges logic
        await client.query(
          `REVOKE UPDATE, DELETE, TRUNCATE ON "${schema}".audit_log FROM "${randomRole}"`,
        );
        await client.query(
          `GRANT INSERT, SELECT ON "${schema}".audit_log TO "${randomRole}"`,
        );

        const auditId = uuidv4();

        // 1. As randomRole, INSERT must succeed
        await client.query(`SET ROLE "${randomRole}"`);
        await client.query(`SET search_path TO "${schema}", public`);
        await client.query(
          `INSERT INTO audit_log (id, action, outcome, actor_id, actor_type, namespace, correlation_id)
           VALUES ($1, 'TEST_ACTION', 'SUCCESS', 'tester', 'SYSTEM', 'test-ns', 'corr-role-test')`,
          [auditId],
        );

        // 2. As randomRole, SELECT must succeed
        const selectRes = await client.query(
          `SELECT id, action FROM audit_log WHERE id = $1`,
          [auditId],
        );
        const selectedRow = selectRes.rows[0] as { id: string; action: string };
        expect(selectedRow.id).toBe(auditId);

        // 3. As randomRole, UPDATE must fail
        await expect(
          client.query(`UPDATE audit_log SET action = 'HACKED' WHERE id = $1`, [
            auditId,
          ]),
        ).rejects.toThrow(/permission denied/i);

        // 4. As randomRole, DELETE must fail
        await expect(
          client.query(`DELETE FROM audit_log WHERE id = $1`, [auditId]),
        ).rejects.toThrow(/permission denied/i);

        // 5. As randomRole, TRUNCATE must fail
        await expect(client.query(`TRUNCATE audit_log`)).rejects.toThrow(
          /permission denied/i,
        );

        await client.query('RESET ROLE');
      } finally {
        await client.query('RESET ROLE').catch(() => {});
        await client
          .query(`DROP ROLE IF EXISTS "${randomRole}"`)
          .catch(() => {});
        client.release();
      }
    });
  });
});
