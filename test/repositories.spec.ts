import { v7 as uuidv7 } from 'uuid';
import {
  createTestDatabase,
  type TestDatabaseContext,
} from './helpers/db-test-helper.js';
import { runMigrations } from '../src/db/migrate.js';
import { withTransaction } from '../src/db/kysely.js';
import {
  FileRepository,
  ReplicaRepository,
  OutboxRepository,
  AuditRepository,
  ApiClientRepository,
  UsageRepository,
  ProcessedEventsRepository,
} from '../src/db/repositories/index.js';
import { OptimisticLockError } from '../src/core/errors/app-error.js';

describe('P1-06 Repositories & Concurrency Guarantees', () => {
  let ctx: TestDatabaseContext;
  let fileRepo: FileRepository;
  let replicaRepo: ReplicaRepository;
  let outboxRepo: OutboxRepository;
  let auditRepo: AuditRepository;
  let clientRepo: ApiClientRepository;
  let usageRepo: UsageRepository;
  let processedRepo: ProcessedEventsRepository;

  beforeAll(async () => {
    ctx = await createTestDatabase();
    await runMigrations(ctx.db, {
      allowLockWait: true,
      migrationTableSchema: ctx.schemaName,
    });

    fileRepo = new FileRepository(ctx.db);
    replicaRepo = new ReplicaRepository(ctx.db);
    outboxRepo = new OutboxRepository(ctx.db);
    auditRepo = new AuditRepository(ctx.db);
    clientRepo = new ApiClientRepository(ctx.db);
    usageRepo = new UsageRepository(ctx.db);
    processedRepo = new ProcessedEventsRepository(ctx.db);
  });

  afterAll(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  describe('FileRepository', () => {
    it('inserts, retrieves, and maps domain fields correctly', async () => {
      const fileId = uuidv7();
      const created = await fileRepo.insert({
        id: fileId,
        namespace: 'esma-tenant',
        tenantId: 'school-1',
        subTenantId: 'branch-1',
        folder: 'assignments',
        storageKey: 'assignments/doc.pdf',
        originalFilename: 'doc.pdf',
        mimetype: 'application/pdf',
        declaredMimetype: 'application/pdf',
        sizeBytes: 1048576n,
        sha256: 'a'.repeat(64),
        visibility: 'tenant',
        primaryProvider: 'local',
        uploadedBy: 'teacher-1',
        tags: ['homework', 'grade-5'],
        attributes: { semester: 'fall' },
        legacyPublicId: 'legacy-doc-1',
        idempotencyKey: 'idem-doc-1',
        correlationId: 'corr-doc-1',
      });

      expect(created.id).toBe(fileId);
      expect(created.sizeBytes).toBe(1048576n);
      expect(created.status).toBe('ACTIVE');
      expect(created.version).toBe(1);
      expect(created.tags).toEqual(['homework', 'grade-5']);
      expect(created.attributes).toEqual({ semester: 'fall' });
      expect(created.createdAt).toBeInstanceOf(Date);

      const byId = await fileRepo.findById(fileId);
      expect(byId).not.toBeNull();
      expect(byId?.id).toBe(fileId);

      const byLegacy = await fileRepo.findByLegacyPublicId('legacy-doc-1');
      expect(byLegacy?.id).toBe(fileId);

      const byIdem = await fileRepo.findByIdempotencyKey(
        'esma-tenant',
        'school-1',
        'idem-doc-1',
      );
      expect(byIdem?.id).toBe(fileId);
    });

    it('enforces optimistic locking on version compare-and-set', async () => {
      const file = await fileRepo.insert({
        namespace: 'esma-tenant',
        tenantId: 'school-1',
        storageKey: 'docs/test-cas.pdf',
        originalFilename: 'test-cas.pdf',
        mimetype: 'application/pdf',
        sizeBytes: 500,
        visibility: 'tenant',
        primaryProvider: 'local',
        uploadedBy: 'teacher-1',
        correlationId: 'corr-cas',
      });

      expect(file.version).toBe(1);

      // Successful update with current version
      const updated = await fileRepo.updateStatus(file.id, 1, {
        status: 'QUARANTINED',
        scanStatus: 'INFECTED',
      });
      expect(updated.version).toBe(2);
      expect(updated.status).toBe('QUARANTINED');
      expect(updated.scanStatus).toBe('INFECTED');

      // Stale update attempt with outdated version 1 fails
      await expect(
        fileRepo.updateStatus(file.id, 1, { status: 'ACTIVE' }),
      ).rejects.toThrow(OptimisticLockError);
    });

    it('supports markDeleting and markDeleted transitions', async () => {
      const file = await fileRepo.insert({
        namespace: 'esma-tenant',
        tenantId: 'school-1',
        storageKey: 'docs/delete-test.pdf',
        originalFilename: 'delete-test.pdf',
        mimetype: 'application/pdf',
        sizeBytes: 100,
        visibility: 'tenant',
        primaryProvider: 'local',
        uploadedBy: 'user-del',
        correlationId: 'corr-del',
      });

      const markedDeleting = await fileRepo.markDeleting(file.id);
      expect(markedDeleting).toBe(true);

      const checkDeleting = await fileRepo.findById(file.id);
      expect(checkDeleting?.status).toBe('DELETING');

      const markedDeleted = await fileRepo.markDeleted(file.id);
      expect(markedDeleted).toBe(true);

      const checkDeleted = await fileRepo.findById(file.id);
      expect(checkDeleted?.status).toBe('DELETED');
      expect(checkDeleted?.deletedAt).toBeInstanceOf(Date);
    });

    it('keyset listing is stable under concurrent inserts', async () => {
      const tenantId = `tenant-keyset-${Date.now()}`;
      const namespace = 'keyset-test';

      // Seed 10 files
      for (let i = 0; i < 10; i++) {
        await fileRepo.insert({
          namespace,
          tenantId,
          storageKey: `k-${i}`,
          originalFilename: `f-${i}.pdf`,
          mimetype: 'application/pdf',
          sizeBytes: 100,
          visibility: 'tenant',
          primaryProvider: 'local',
          uploadedBy: 'user-keyset',
          correlationId: `corr-${i}`,
        });
      }

      // Fetch first page of 5 items
      const page1 = await fileRepo.list({ namespace, tenantId }, null, 5);
      expect(page1.items.length).toBe(5);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).not.toBeNull();

      // Interleave concurrent inserts while paginating
      for (let i = 10; i < 15; i++) {
        await fileRepo.insert({
          namespace,
          tenantId,
          storageKey: `k-interleaved-${i}`,
          originalFilename: `interleaved-${i}.pdf`,
          mimetype: 'application/pdf',
          sizeBytes: 100,
          visibility: 'tenant',
          primaryProvider: 'local',
          uploadedBy: 'user-keyset',
          correlationId: `corr-int-${i}`,
        });
      }

      // Fetch second page using cursor from page 1
      const page2 = await fileRepo.list(
        { namespace, tenantId },
        page1.nextCursor,
        5,
      );
      expect(page2.items.length).toBe(5);

      // Verify no overlap between page 1 and page 2
      const page1Ids = new Set(page1.items.map((it) => it.id));
      for (const item of page2.items) {
        expect(page1Ids.has(item.id)).toBe(false);
      }
    });
  });

  describe('ReplicaRepository', () => {
    it('20 parallel claim calls for one replica: exactly one returns true', async () => {
      const file = await fileRepo.insert({
        namespace: 'esma-tenant',
        tenantId: 'school-replica',
        storageKey: 'replica/test.png',
        originalFilename: 'test.png',
        mimetype: 'image/png',
        sizeBytes: 2048,
        visibility: 'tenant',
        primaryProvider: 'local',
        uploadedBy: 'user-rep',
        correlationId: 'corr-claim-test',
      });

      await replicaRepo.insertMany([
        {
          fileId: file.id,
          provider: 'seaweedfs',
          role: 'secondary',
          status: 'QUEUED',
          providerKey: 'seaweed/key-1',
        },
      ]);

      // Execute 20 concurrent claims on the same replica
      const claimPromises = Array.from({ length: 20 }, () =>
        replicaRepo.claim(file.id, 'seaweedfs'),
      );
      const results = await Promise.all(claimPromises);

      const trueCount = results.filter((res) => res === true).length;
      const falseCount = results.filter((res) => res === false).length;

      expect(trueCount).toBe(1);
      expect(falseCount).toBe(19);

      // Subsequent claim must also fail
      const lateClaim = await replicaRepo.claim(file.id, 'seaweedfs');
      expect(lateClaim).toBe(false);
    });

    it('marks replica available, failed, and finds stale replicas', async () => {
      const file = await fileRepo.insert({
        namespace: 'esma-tenant',
        tenantId: 'school-replica',
        storageKey: 'replica/test2.png',
        originalFilename: 'test2.png',
        mimetype: 'image/png',
        sizeBytes: 1024,
        visibility: 'tenant',
        primaryProvider: 'local',
        uploadedBy: 'user-rep',
        correlationId: 'corr-rep-2',
      });

      await replicaRepo.insertMany([
        {
          fileId: file.id,
          provider: 'cloudinary',
          role: 'secondary',
          status: 'IN_PROGRESS',
          providerKey: 'cld/key-1',
        },
      ]);

      // Mark failed increments attempts and records error
      await replicaRepo.markFailed(
        file.id,
        'cloudinary',
        'Timeout connecting to Cloudinary',
      );
      let replicas = await replicaRepo.listByFile(file.id);
      expect(replicas[0].status).toBe('FAILED');
      expect(replicas[0].attempts).toBe(1);
      expect(replicas[0].lastError).toBe('Timeout connecting to Cloudinary');

      // Requeue
      await replicaRepo.requeue(file.id, 'cloudinary');
      replicas = await replicaRepo.listByFile(file.id);
      expect(replicas[0].status).toBe('QUEUED');

      // Mark available
      await replicaRepo.markAvailable(file.id, 'cloudinary', {
        url: 'https://cdn.cloudinary.com/doc.png',
        etag: '"etag123"',
      });
      replicas = await replicaRepo.listByFile(file.id);
      expect(replicas[0].status).toBe('AVAILABLE');
      expect(replicas[0].url).toBe('https://cdn.cloudinary.com/doc.png');
      expect(replicas[0].etag).toBe('"etag123"');
      expect(replicas[0].syncedAt).toBeInstanceOf(Date);

      // Find stale replicas
      const futureDate = new Date(Date.now() + 60000);
      const stale = await replicaRepo.findStale('AVAILABLE', futureDate, 10);
      expect(stale.some((r) => r.fileId === file.id)).toBe(true);
    });
  });

  describe('OutboxRepository', () => {
    it('Two parallel claimBatch calls never return the same row', async () => {
      // Enqueue 10 distinct outbox events
      const eventIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const ev = await outboxRepo.enqueue({
          topic: 'file.events',
          partitionKey: `school-${i}`,
          eventType: 'FILE_UPLOADED',
          envelope: { fileIndex: i },
        });
        eventIds.push(ev.id);
      }

      // Simulate two concurrent workers running claimBatch within transactions
      let batch1Ids: string[] = [];
      let batch2Ids: string[] = [];

      await Promise.all([
        withTransaction(ctx.db, async (trx) => {
          const batch = await outboxRepo.claimBatch(6, trx);
          batch1Ids = batch.map((b) => b.id);
          // Hold the lock briefly to ensure worker 2 runs concurrently
          await new Promise((resolve) => setTimeout(resolve, 50));
        }),
        withTransaction(ctx.db, async (trx) => {
          // Allow worker 1 to acquire locks first
          await new Promise((resolve) => setTimeout(resolve, 10));
          const batch = await outboxRepo.claimBatch(6, trx);
          batch2Ids = batch.map((b) => b.id);
        }),
      ]);

      expect(batch1Ids.length).toBeGreaterThan(0);
      expect(batch2Ids.length).toBeGreaterThan(0);

      // Crucial: There must be ZERO overlap between rows claimed by worker 1 and worker 2
      const batch1Set = new Set(batch1Ids);
      for (const id of batch2Ids) {
        expect(batch1Set.has(id)).toBe(false);
      }

      // Cleanup: mark published
      for (const id of [...batch1Ids, ...batch2Ids]) {
        await outboxRepo.markPublished(id);
      }

      // Delete published older than tomorrow
      const deleted = await outboxRepo.deletePublishedOlderThan(
        new Date(Date.now() + 86400000),
      );
      expect(deleted).toBeGreaterThanOrEqual(
        batch1Ids.length + batch2Ids.length,
      );
    });
  });

  describe('UsageRepository', () => {
    it('tryReserve never lets bytes_used exceed max_bytes under 50 parallel calls', async () => {
      const namespace = 'quota-test';
      const tenantId = `tenant-quota-${Date.now()}`;

      // Initialize quota: max_bytes = 1000, max_files = 100
      await usageRepo.setQuota(namespace, tenantId, 1000, 100);

      // 50 parallel calls each trying to reserve 100 bytes
      const reserveCalls = Array.from({ length: 50 }, () =>
        usageRepo.tryReserve(namespace, tenantId, 100, 1),
      );

      const results = await Promise.all(reserveCalls);

      const successCount = results.filter((r) => r === true).length;
      const rejectedCount = results.filter((r) => r === false).length;

      // Exactly 10 calls can succeed (10 * 100 = 1000 max_bytes)
      expect(successCount).toBe(10);
      expect(rejectedCount).toBe(40);

      const usage = await usageRepo.get(namespace, tenantId);
      expect(usage).not.toBeNull();
      expect(usage?.bytesUsed).toBe(1000n);
      expect(usage?.fileCount).toBe(10n);

      // Release 200 bytes
      await usageRepo.release(namespace, tenantId, 200, 2);
      const afterRelease = await usageRepo.get(namespace, tenantId);
      expect(afterRelease?.bytesUsed).toBe(800n);
      expect(afterRelease?.fileCount).toBe(8n);
    });
  });

  describe('ProcessedEventsRepository', () => {
    it('idempotently allows only one winner per consumer and eventId', async () => {
      const consumer = 'outbox-relay';
      const eventId = uuidv7();

      // 10 concurrent tryMark attempts for the same event
      const attempts = Array.from({ length: 10 }, () =>
        processedRepo.tryMark(consumer, eventId),
      );

      const results = await Promise.all(attempts);

      const firstTimeTrue = results.filter((r) => r === true).length;
      const duplicateFalse = results.filter((r) => r === false).length;

      expect(firstTimeTrue).toBe(1);
      expect(duplicateFalse).toBe(9);

      // Subsequent attempt is also false
      const later = await processedRepo.tryMark(consumer, eventId);
      expect(later).toBe(false);
    });
  });

  describe('ApiClientRepository', () => {
    it('creates, retrieves, touches, and revokes API clients', async () => {
      const client = await clientRepo.create({
        name: 'Portal Ingestion Client',
        keyPrefix: `prefix_${Date.now()}`,
        keyHash: 'hash_secret_123',
        namespace: 'esma-tenant',
        tenantIds: ['school-1', 'school-2'],
        allowAnyTenant: false,
        scopes: ['files:read', 'files:write'],
      });

      expect(client.id).toBeDefined();
      expect(client.status).toBe('ACTIVE');

      const found = await clientRepo.findByPrefix(client.keyPrefix);
      expect(found).not.toBeNull();
      expect(found?.name).toBe('Portal Ingestion Client');

      await clientRepo.touchLastUsed(client.id);
      const touched = await clientRepo.findByPrefix(client.keyPrefix);
      expect(touched?.lastUsedAt).toBeInstanceOf(Date);

      const revoked = await clientRepo.revoke(client.id);
      expect(revoked).toBe(true);

      const afterRevoke = await clientRepo.findByPrefix(client.keyPrefix);
      expect(afterRevoke?.status).toBe('REVOKED');
      expect(afterRevoke?.revokedAt).toBeInstanceOf(Date);
    });
  });

  describe('AuditRepository', () => {
    it('appends and queries audit records with keyset pagination', async () => {
      const namespace = 'audit-test';
      const tenantId = `tenant-${Date.now()}`;

      for (let i = 0; i < 5; i++) {
        await auditRepo.insert({
          action: `FILE_DOWNLOAD_${i}`,
          outcome: 'SUCCESS',
          actorId: `user-${i}`,
          actorType: 'user',
          roles: ['teacher'],
          namespace,
          tenantId,
          correlationId: `corr-audit-${i}`,
          details: { index: i },
        });
      }

      const results = await auditRepo.query({ namespace, tenantId }, null, 3);

      expect(results.items.length).toBe(3);
      expect(results.hasMore).toBe(true);
      expect(results.nextCursor).not.toBeNull();

      const page2 = await auditRepo.query(
        { namespace, tenantId },
        results.nextCursor,
        3,
      );
      expect(page2.items.length).toBe(2);
      expect(page2.hasMore).toBe(false);
    });
  });

  describe('Transactions & Rollback', () => {
    it('rolls back database mutations when transaction errors', async () => {
      const fileId = uuidv7();

      await expect(
        withTransaction(ctx.db, async (trx) => {
          await fileRepo.insert(
            {
              id: fileId,
              namespace: 'esma-tenant',
              tenantId: 'school-trx',
              storageKey: 'trx/test.pdf',
              originalFilename: 'test.pdf',
              mimetype: 'application/pdf',
              sizeBytes: 100,
              visibility: 'tenant',
              primaryProvider: 'local',
              uploadedBy: 'user-trx',
              correlationId: 'corr-trx',
            },
            trx,
          );

          // Force an intentional rollback
          throw new Error('Rollback intentionally triggered');
        }),
      ).rejects.toThrow('Rollback intentionally triggered');

      // The record must NOT exist in the database
      const found = await fileRepo.findById(fileId);
      expect(found).toBeNull();
    });
  });
});
