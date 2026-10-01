/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await, @typescript-eslint/unbound-method */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { ScanWorker } from '../../src/workers/scan.worker.js';
import { FakeStorageDriver } from '../helpers/storage-driver.mock.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { MemoryBroker } from '../../src/events/memory-broker.js';
import { EVENT_TYPES, type FileScanPayload } from '../../src/events/catalog.js';
import {
  createEnvelope,
  type EventEnvelope,
} from '../../src/events/envelope.js';
import type { FileRecord, FileReplica } from '../../src/core/types.js';
import type { AppConfigService } from '../../src/config/config.service.js';
import type { DatabaseService } from '../../src/db/database.service.js';
import type { FileRepository } from '../../src/db/repositories/file.repository.js';
import type { ReplicaRepository } from '../../src/db/repositories/replica.repository.js';
import type { OutboxWriter } from '../../src/events/outbox-writer.js';
import type { ClamAvScanner } from '../../src/ingest/clamav.scanner.js';
import { ClamAvError } from '../../src/ingest/clamav.scanner.js';

describe('ScanWorker (P5-07)', () => {
  let worker: ScanWorker;
  let seaweedDriver: FakeStorageDriver;
  let storageRegistry: StorageRegistry;
  let broker: MemoryBroker;

  let mockFile: FileRecord;
  let mockReplicas: FileReplica[];
  let enqueuedOutboxEvents: EventEnvelope[];

  let mockDbService: DatabaseService;
  let mockFileRepo: FileRepository;
  let mockReplicaRepo: ReplicaRepository;
  let mockOutboxWriter: OutboxWriter;
  let mockConfigService: AppConfigService;
  let mockClamAvScanner: ClamAvScanner;

  const content = Buffer.from('test content for virus scanning');

  beforeEach(async () => {
    seaweedDriver = new FakeStorageDriver('seaweedfs');
    await seaweedDriver.upload({
      key: 'tenants/t-1/docs/file-1.pdf',
      source: () => Readable.from([content]),
      size: content.length,
      sha256: 'sha256-hash',
      mimetype: 'application/pdf',
      visibility: 'tenant',
    });

    storageRegistry = {
      get: (name: string) => {
        if (name === 'seaweedfs') return seaweedDriver;
        throw new Error(`Unknown driver ${name}`);
      },
      has: (name: string) => name === 'seaweedfs',
    } as unknown as StorageRegistry;
    broker = new MemoryBroker();
    enqueuedOutboxEvents = [];

    mockFile = {
      id: 'f-scan-1',
      namespace: 'tenant',
      tenantId: 'school-1',
      subTenantId: null,
      folder: 'docs',
      storageKey: 'tenants/t-1/docs/file-1.pdf',
      originalFilename: 'file.pdf',
      mimetype: 'application/pdf',
      declaredMimetype: 'application/pdf',
      sizeBytes: BigInt(content.length),
      sha256: 'sha256-hash',
      visibility: 'tenant',
      status: 'ACTIVE',
      scanStatus: 'PENDING',
      replicationStatus: 'QUEUED',
      primaryProvider: 'seaweedfs',
      uploadedBy: 'u-1',
      tags: [],
      attributes: {},
      legacyPublicId: null,
      idempotencyKey: null,
      correlationId: 'corr-scan-1',
      expiresAt: null,
      version: 1,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockReplicas = [
      {
        fileId: 'f-scan-1',
        provider: 'seaweedfs',
        role: 'primary',
        status: 'AVAILABLE',
        providerKey: 'tenants/t-1/docs/file-1.pdf',
        providerMeta: {},
        url: null,
        etag: null,
        lastError: null,
        attempts: 0,
        syncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        fileId: 'f-scan-1',
        provider: 'local',
        role: 'secondary',
        status: 'QUEUED',
        providerKey: 'tenants/t-1/docs/file-1.pdf',
        providerMeta: {},
        url: null,
        etag: null,
        lastError: null,
        attempts: 0,
        syncedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    mockFileRepo = {
      findById: vi.fn().mockImplementation(async (id: string) => {
        if (id === mockFile.id) return { ...mockFile };
        return null;
      }),
      updateStatus: vi
        .fn()
        .mockImplementation(
          async (id: string, version: number, updates: any) => {
            Object.assign(mockFile, updates, { version: version + 1 });
            return { ...mockFile };
          },
        ),
    } as unknown as FileRepository;

    mockReplicaRepo = {
      listByFile: vi.fn().mockImplementation(async () => [...mockReplicas]),
      markDeleted: vi
        .fn()
        .mockImplementation(async (fileId: string, provider: string) => {
          const r = mockReplicas.find(
            (rep) => rep.fileId === fileId && rep.provider === provider,
          );
          if (r) {
            r.status = 'DELETED';
          }
          return true;
        }),
      updateStatus: vi
        .fn()
        .mockImplementation(
          async (fileId: string, provider: string, status: any, meta: any) => {
            const r = mockReplicas.find(
              (rep) => rep.fileId === fileId && rep.provider === provider,
            );
            if (r) {
              r.status = status;
              if (meta?.error) r.lastError = meta.error;
            }
          },
        ),
    } as unknown as ReplicaRepository;

    mockOutboxWriter = {
      enqueue: vi.fn().mockImplementation(async (_trx: any, envelope: any) => {
        enqueuedOutboxEvents.push(envelope);
      }),
    } as unknown as OutboxWriter;

    const fakeTrx = {};
    mockDbService = {
      getDb: vi.fn().mockReturnValue({
        transaction: () => ({
          execute: async (callback: (trx: any) => Promise<any>) =>
            callback(fakeTrx),
        }),
      }),
    } as unknown as DatabaseService;

    mockConfigService = {
      consumerHandlerTimeoutMs: 10000,
      consumerShutdownTimeoutMs: 5000,
      scanFailMode: 'closed',
    } as unknown as AppConfigService;

    mockClamAvScanner = {
      scanStream: vi
        .fn()
        .mockResolvedValue({ clean: true, scannedBytes: content.length }),
      ping: vi.fn().mockResolvedValue(true),
      scan: vi.fn().mockResolvedValue({ clean: true }),
    } as unknown as ClamAvScanner;

    worker = new ScanWorker(
      mockConfigService,
      mockDbService,
      mockFileRepo,
      mockReplicaRepo,
      storageRegistry,
      mockOutboxWriter,
      mockClamAvScanner,
      broker,
    );
  });

  const createScanEnvelope = (fileId: string): EventEnvelope<FileScanPayload> =>
    createEnvelope({
      eventType: EVENT_TYPES.FILE_SCAN,
      partitionKey: fileId,
      payload: { fileId },
      namespace: 'tenant',
      tenantId: 'school-1',
    });

  it('scans a clean file, marks scanStatus=CLEAN, and emits file.scanned', async () => {
    const envelope = createScanEnvelope('f-scan-1');
    const outcome = await worker.handleScan(envelope, 1, 3);

    expect(outcome).toEqual({ kind: 'ack' });
    expect(mockFile.scanStatus).toBe('CLEAN');
    expect(mockFile.status).toBe('ACTIVE');

    // Emitted file.scanned event
    const scannedEvent = enqueuedOutboxEvents.find(
      (e) => e.eventType === EVENT_TYPES.FILE_SCANNED,
    );
    expect(scannedEvent).toBeDefined();
    expect(scannedEvent?.payload).toEqual({
      fileId: 'f-scan-1',
      result: 'CLEAN',
    });
  });

  it('detects an infected file: quarantines file, cancels replicas, emits security event', async () => {
    mockClamAvScanner.scanStream = vi.fn().mockResolvedValue({
      clean: false,
      threat: 'Eicar-Test-Signature',
      scannedBytes: content.length,
    });

    const envelope = createScanEnvelope('f-scan-1');
    const outcome = await worker.handleScan(envelope, 1, 3);

    expect(outcome).toEqual({ kind: 'ack' });
    expect(mockFile.scanStatus).toBe('INFECTED');
    expect(mockFile.status).toBe('QUARANTINED');

    // Secondary replica cancelled / marked DELETED
    const secondary = mockReplicas.find((r) => r.provider === 'local');
    expect(secondary?.status).toBe('DELETED');

    // Emitted file.scanned event with threat info
    const scannedEvent = enqueuedOutboxEvents.find(
      (e) => e.eventType === EVENT_TYPES.FILE_SCANNED,
    );
    expect(scannedEvent).toBeDefined();
    expect(scannedEvent?.payload).toEqual({
      fileId: 'f-scan-1',
      result: 'INFECTED',
      threat: 'Eicar-Test-Signature',
    });
  });

  it('retries when scanner errors before maxAttempts', async () => {
    mockClamAvScanner.scanStream = vi
      .fn()
      .mockRejectedValue(new ClamAvError('Connection reset by peer'));

    const envelope = createScanEnvelope('f-scan-1');
    const outcome = await worker.handleScan(envelope, 1, 3);

    expect(outcome.kind).toBe('retry');
    if (outcome.kind === 'retry') {
      expect(outcome.delayMs).toBeGreaterThan(0);
      expect(outcome.reason).toContain('Connection reset by peer');
    }
    // File remains in PENDING scanStatus
    expect(mockFile.scanStatus).toBe('PENDING');
  });

  it('exhausts retries with SCAN_FAIL_MODE=closed: marks scanStatus=ERROR', async () => {
    mockClamAvScanner.scanStream = vi
      .fn()
      .mockRejectedValue(new ClamAvError('Daemon unreachable'));

    // Config is closed by default
    const envelope = createScanEnvelope('f-scan-1');
    const outcome = await worker.handleScan(envelope, 3, 3);

    expect(outcome).toEqual({ kind: 'ack' });
    expect(mockFile.scanStatus).toBe('ERROR');

    const scannedEvent = enqueuedOutboxEvents.find(
      (e) => e.eventType === EVENT_TYPES.FILE_SCANNED,
    );
    expect((scannedEvent?.payload as any)?.result).toBe('ERROR');
  });

  it('exhausts retries with SCAN_FAIL_MODE=open: marks scanStatus=CLEAN', async () => {
    (mockConfigService as any).scanFailMode = 'open';
    mockClamAvScanner.scanStream = vi
      .fn()
      .mockRejectedValue(new ClamAvError('Daemon unreachable'));

    const envelope = createScanEnvelope('f-scan-1');
    const outcome = await worker.handleScan(envelope, 3, 3);

    expect(outcome).toEqual({ kind: 'ack' });
    expect(mockFile.scanStatus).toBe('CLEAN');

    const scannedEvent = enqueuedOutboxEvents.find(
      (e) => e.eventType === EVENT_TYPES.FILE_SCANNED,
    );
    expect((scannedEvent?.payload as any)?.result).toBe('CLEAN');
  });

  it('ignores file if already marked CLEAN or INFECTED', async () => {
    mockFile.scanStatus = 'CLEAN';
    const envelope = createScanEnvelope('f-scan-1');
    const outcome = await worker.handleScan(envelope, 1, 3);

    expect(outcome).toEqual({ kind: 'ack' });
    expect(mockClamAvScanner.scanStream).not.toHaveBeenCalled();
  });
});
