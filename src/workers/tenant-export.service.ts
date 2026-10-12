import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { v7 as uuidv7 } from 'uuid';
import { sql } from 'kysely';
import { DatabaseService } from '../db/database.service.js';
import { StorageRegistry } from '../storage/registry.js';
import { OutboxRepository } from '../db/repositories/outbox.repository.js';
import { DomainEventPublisher } from '../events/domain-event.publisher.js';
import { FileRepository } from '../db/repositories/file.repository.js';
import { ReplicaRepository } from '../db/repositories/replica.repository.js';
import { buildZipArchive, type ZipEntry } from './zip-builder.js';
import type { ProviderName } from '../storage/types.js';

export interface TenantExportRequestPayload {
  requestId: string;
  organizationId: string;
  requestedAt: string;
  owners?: string[];
}

export interface TenantExportReceipt {
  requestId: string;
  organizationId: string;
  owner: string;
  status: 'COMPLETED' | 'PARTIAL' | 'SKIPPED';
  completedAt: string;
  counts: {
    files: number;
    bytes: number;
    replicas: number;
  };
  bundleFileId: string | null;
  failures: Array<{ fileId: string; error: string }>;
}

export const EXPORT_COMPLETED_TOPIC = 'esma.platform.tenant-export-completed.v1';

@Injectable()
export class TenantExportService {
  private readonly logger = new Logger(TenantExportService.name);

  constructor(
    private readonly dbService: DatabaseService,
    private readonly storageRegistry: StorageRegistry,
    private readonly outboxRepo: OutboxRepository,
    private readonly domainEventPublisher: DomainEventPublisher,
    private readonly fileRepo: FileRepository,
    private readonly replicaRepo: ReplicaRepository,
  ) {}

  /**
   * Executes tenant export bundle creation according to UR-19:
   * 1. Verifies owners filter.
   * 2. Gathers all active, non-infected files for the organization.
   * 3. Assembles manifest.jsonl and pulls file contents from storage drivers.
   * 4. Bundles into a ZIP archive.
   * 5. Saves ZIP archive in namespace 'tenant-exports' (14-day retention).
   * 6. Emits files.tenant.exported.v1 to esma.files.events.v1.
   * 7. Emits completion receipt to esma.platform.tenant-export-completed.v1.
   */
  async exportTenant(payload: TenantExportRequestPayload): Promise<TenantExportReceipt> {
    const { requestId, organizationId } = payload;
    const completedAt = new Date().toISOString();

    // 1. Check owners filter
    if (payload.owners && payload.owners.length > 0 && !payload.owners.includes('files')) {
      this.logger.log(
        `Tenant export ${requestId} skipped: 'files' not in owners [${payload.owners.join(', ')}]`,
      );
      return {
        requestId,
        organizationId,
        owner: 'files',
        status: 'SKIPPED',
        completedAt,
        counts: { files: 0, bytes: 0, replicas: 0 },
        bundleFileId: null,
        failures: [],
      };
    }

    const db = this.dbService.getDb();
    if (!db) {
      throw new Error('Database service is unavailable for tenant export');
    }

    // 2. Query all active, non-infected, non-deleted files for this tenant (UR-19.2)
    const files = await sql<{
      id: string;
      namespace: string;
      original_filename: string;
      mimetype: string;
      size_bytes: string;
      sha256: string | null;
      attributes: Record<string, unknown> | null;
      created_at: string;
      storage_key: string;
      primary_provider: string;
    }>`
      SELECT
        id, namespace, original_filename, mimetype, size_bytes,
        sha256, attributes, created_at, storage_key, primary_provider
      FROM files
      WHERE tenant_id = ${organizationId}
        AND status = 'ACTIVE'
        AND scan_status != 'INFECTED'
        AND namespace != 'tenant-exports'
      ORDER BY created_at ASC
    `.execute(db);

    const zipEntries: ZipEntry[] = [];
    const manifestLines: string[] = [];
    const failures: Array<{ fileId: string; error: string }> = [];
    let exportedBytes = 0;
    let exportedFiles = 0;

    for (const f of files.rows) {
      const sanitizedName = f.original_filename.replace(/[/\\?%*:|"<>]/g, '_');
      const zipPath = `files/${f.namespace}/${f.id}-${sanitizedName}`;

      manifestLines.push(
        JSON.stringify({
          fileId: f.id,
          namespace: f.namespace,
          filename: f.original_filename,
          mime: f.mimetype,
          size: Number(f.size_bytes || '0'),
          sha256: f.sha256 ?? null,
          attributes: f.attributes ?? {},
          createdAt: f.created_at,
          path: zipPath,
        }),
      );

      // Fetch file content from primary storage driver
      try {
        const driver = this.storageRegistry.get(f.primary_provider as ProviderName);
        if (!driver) {
          throw new Error(`Storage driver '${f.primary_provider}' not found`);
        }

        const { stream: readStream } = await driver.downloadStream({
          provider: f.primary_provider as ProviderName,
          key: f.storage_key,
        });

        const chunks: Buffer[] = [];
        for await (const chunk of readStream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const fileBuffer = Buffer.concat(chunks);

        zipEntries.push({
          path: zipPath,
          data: fileBuffer,
        });

        exportedBytes += fileBuffer.length;
        exportedFiles++;
      } catch (err) {
        this.logger.warn(`Failed to export file ${f.id}: ${String(err)}`);
        failures.push({
          fileId: f.id,
          error: String(err),
        });
      }
    }

    // Add manifest.jsonl to the ZIP root
    const manifestBuffer = Buffer.from(manifestLines.join('\n') + '\n', 'utf8');
    zipEntries.unshift({
      path: 'manifest.jsonl',
      data: manifestBuffer,
    });

    // 4. Build ZIP bundle Buffer
    const zipBundle = buildZipArchive(zipEntries);
    const bundleFileId = uuidv7();
    const bundleSha256 = crypto.createHash('sha256').update(zipBundle).digest('hex');
    const bundleSize = zipBundle.length;
    const bundleStorageKey = `${organizationId}/tenant-exports/${new Date().getUTCFullYear()}/${String(new Date().getUTCMonth() + 1).padStart(2, '0')}/${bundleFileId}.zip`;
    const retainUntil = new Date(Date.now() + 14 * 86400 * 1000); // 14-day retention (UR-19.3)

    // Store ZIP in primary storage (seaweedfs or local)
    const primaryDriver = this.storageRegistry.get('seaweedfs') ?? this.storageRegistry.get('local');
    if (!primaryDriver) {
      throw new Error('No storage driver available to store tenant export bundle');
    }

    await primaryDriver.upload({
      key: bundleStorageKey,
      source: () => Readable.from(zipBundle),
      size: bundleSize,
      sha256: bundleSha256,
      mimetype: 'application/zip',
      visibility: 'private',
    });

    // Save bundle record in files table
    await this.fileRepo.insert({
      id: bundleFileId,
      namespace: 'tenant-exports',
      tenantId: organizationId,
      subTenantId: null,
      folder: '',
      storageKey: bundleStorageKey,
      originalFilename: `tenant-export-${organizationId}.zip`,
      mimetype: 'application/zip',
      declaredMimetype: 'application/zip',
      sizeBytes: BigInt(bundleSize),
      sha256: bundleSha256,
      visibility: 'private',
      status: 'ACTIVE',
      scanStatus: 'SKIPPED',
      replicationStatus: 'NOT_REQUIRED',
      primaryProvider: primaryDriver.name,
      uploadedBy: 'system',
      actingService: 'platform-export-worker',
      tags: ['tenant-export'],
      attributes: {
        requestId,
        organizationId,
        exportedFilesCount: exportedFiles,
        exportedBytesTotal: exportedBytes,
      },
      legacyPublicId: null,
      idempotencyKey: null,
      correlationId: requestId,
      retainUntil,
      claimed: true,
      claimedAt: new Date(),
    });

    // Save primary replica
    await this.replicaRepo.insertMany([
      {
        fileId: bundleFileId,
        provider: primaryDriver.name,
        role: 'primary',
        status: 'AVAILABLE',
        providerKey: bundleStorageKey,
        providerMeta: { contentType: 'application/zip' },
        url: null,
        etag: null,
        syncedAt: new Date(),
      },
    ]);

    // 5. Emit files.tenant.exported.v1 to esma.files.events.v1 (UR-19.3)
    await this.domainEventPublisher.publish(null, {
      eventType: 'files.tenant.exported.v1',
      organizationId,
      correlationId: requestId,
      data: {
        requestId,
        bundleFileId,
        files: exportedFiles,
        bytes: exportedBytes,
      },
    });

    const status: 'COMPLETED' | 'PARTIAL' =
      failures.length === 0 ? 'COMPLETED' : 'PARTIAL';

    const receipt: TenantExportReceipt = {
      requestId,
      organizationId,
      owner: 'files',
      status,
      completedAt: new Date().toISOString(),
      counts: {
        files: exportedFiles,
        bytes: exportedBytes,
        replicas: 1,
      },
      bundleFileId,
      failures,
    };

    // 6. Emit receipt to esma.platform.tenant-export-completed.v1
    await this.outboxRepo.enqueue({
      topic: EXPORT_COMPLETED_TOPIC,
      partitionKey: organizationId,
      eventType: 'TENANT_EXPORT_RECEIPT',
      envelope: receipt as unknown as Record<string, unknown>,
    });

    this.logger.log(
      `Tenant export completed for org ${organizationId}: bundle=${bundleFileId}, status=${status}, files=${exportedFiles}, bytes=${exportedBytes}`,
    );

    return receipt;
  }
}
