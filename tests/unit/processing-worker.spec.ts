/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-call */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { ProcessingWorker } from '../../src/workers/processing.worker.js';
import type { AppConfigService } from '../../src/config/config.service.js';
import type { FileRepository } from '../../src/db/repositories/file.repository.js';
import type { StorageRegistry } from '../../src/storage/registry.js';
import type { OutboxWriter } from '../../src/events/outbox-writer.js';
import type { DerivativesService } from '../../src/ingest/derivatives.service.js';
import type { IMessageBroker } from '../../src/events/broker.interface.js';
import { EVENT_TYPES } from '../../src/events/catalog.js';
import type { EventEnvelope } from '../../src/events/envelope.js';
import type { FileProcessPayload } from '../../src/events/catalog.js';
import type { FileRecord } from '../../src/core/types.js';

describe('ProcessingWorker (P5-08)', () => {
  let worker: ProcessingWorker;
  let mockConfig: AppConfigService;
  let mockFileRepo: FileRepository;
  let mockStorageRegistry: StorageRegistry;
  let mockOutboxWriter: OutboxWriter;
  let mockDerivativesService: DerivativesService;
  let mockBroker: IMessageBroker;
  let mockPrimaryDriver: any;

  const sampleFile: FileRecord = {
    id: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c3b90',
    namespace: 'esma-tenant',
    tenantId: 'tenant-1',
    subTenantId: null,
    folder: 'avatars',
    storageKey:
      'uploads/esma-tenant/tenant-1/avatars/0198f3a2-7c1e-7b40-9d2a-5e6f1a8c3b90.jpg',
    originalFilename: 'profile.jpg',
    mimetype: 'image/jpeg',
    declaredMimetype: 'image/jpeg',
    sizeBytes: 150000n,
    sha256: 'abc123sha',
    visibility: 'tenant',
    status: 'ACTIVE',
    scanStatus: 'CLEAN',
    replicationStatus: 'SYNCED',
    primaryProvider: 'local',
    uploadedBy: 'user-1',
    tags: [],
    attributes: {},
    derivatives: {},
    legacyPublicId: null,
    idempotencyKey: null,
    correlationId: 'corr-123',
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const sampleEnvelope: EventEnvelope<FileProcessPayload> = {
    eventId: 'evt-1',
    eventType: EVENT_TYPES.FILE_PROCESS,
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    correlationId: 'corr-123',
    namespace: 'esma-tenant',
    tenantId: 'tenant-1',
    partitionKey: sampleFile.id,
    attempt: 0,
    payload: {
      fileId: sampleFile.id,
      operations: ['thumb', 'medium'],
    },
  };

  beforeEach(() => {
    mockConfig = {
      derivativeConcurrency: 2,
      consumerHandlerTimeoutMs: 30000,
      consumerShutdownTimeoutMs: 5000,
      eventsEnabled: true,
    } as unknown as AppConfigService;

    mockFileRepo = {
      findById: vi.fn().mockResolvedValue(sampleFile),
      updateDerivatives: vi.fn().mockResolvedValue({ ...sampleFile }),
    } as unknown as FileRepository;

    mockPrimaryDriver = {
      name: 'local',
      downloadStream: vi.fn().mockResolvedValue({
        stream: Readable.from([Buffer.from('fake-image-bytes')]),
      }),
      upload: vi.fn().mockResolvedValue({
        ref: { provider: 'local', key: 'test.d/thumb.webp' },
        size: 5000,
      }),
    };

    mockStorageRegistry = {
      get: vi.fn().mockReturnValue(mockPrimaryDriver),
    } as unknown as StorageRegistry;

    mockOutboxWriter = {
      enqueue: vi.fn().mockResolvedValue(undefined),
    } as unknown as OutboxWriter;

    mockDerivativesService = {
      isDerivableImage: vi.fn().mockReturnValue(true),
      buildDerivativeKey: vi
        .fn()
        .mockImplementation((k, v) => `${k}.d/${v}.webp`),
      generateDerivatives: vi.fn().mockResolvedValue([
        {
          name: 'thumb',
          buffer: Buffer.from('thumb-webp-data'),
          width: 256,
          height: 192,
          size: 4500,
          mimetype: 'image/webp',
        },
        {
          name: 'medium',
          buffer: Buffer.from('medium-webp-data'),
          width: 1024,
          height: 768,
          size: 18000,
          mimetype: 'image/webp',
        },
      ]),
    } as unknown as DerivativesService;

    mockBroker = {
      subscribe: vi.fn().mockResolvedValue({
        close: vi.fn().mockResolvedValue(undefined),
      }),
    } as unknown as IMessageBroker;

    worker = new ProcessingWorker(
      mockConfig,
      mockFileRepo,
      mockStorageRegistry,
      mockOutboxWriter,
      mockDerivativesService,
      mockBroker,
    );
  });

  it('successfully generates, uploads, stores derivatives and emits file.processed', async () => {
    const outcome = await worker.handleProcess(sampleEnvelope, 0, 3);

    expect(outcome).toEqual({ kind: 'ack' });
    expect(mockDerivativesService.generateDerivatives).toHaveBeenCalledWith(
      Buffer.from('fake-image-bytes'),
      ['thumb', 'medium'],
    );
    expect(mockPrimaryDriver.upload).toHaveBeenCalledTimes(2);

    expect(mockFileRepo.updateDerivatives).toHaveBeenCalledWith(
      sampleFile.id,
      expect.objectContaining({
        thumb: expect.objectContaining({
          key: `${sampleFile.storageKey}.d/thumb.webp`,
          size: 4500,
          width: 256,
          height: 192,
          mimetype: 'image/webp',
        }),
        medium: expect.objectContaining({
          key: `${sampleFile.storageKey}.d/medium.webp`,
          size: 18000,
          width: 1024,
          height: 768,
          mimetype: 'image/webp',
        }),
      }),
    );

    expect(mockOutboxWriter.enqueue).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        eventType: EVENT_TYPES.FILE_PROCESSED,
        partitionKey: sampleFile.id,
        payload: expect.objectContaining({
          fileId: sampleFile.id,
          derivatives: ['thumb', 'medium'],
        }),
      }),
    );

    expect(worker.metrics.processed).toBe(1);
  });

  it('defers with retry when virus scan is PENDING', async () => {
    vi.mocked(mockFileRepo.findById).mockResolvedValueOnce({
      ...sampleFile,
      scanStatus: 'PENDING',
    });

    const outcome = await worker.handleProcess(sampleEnvelope, 0, 3);

    expect(outcome).toEqual({
      kind: 'retry',
      delayMs: 5000,
      reason: 'Virus scan is pending',
    });
    expect(mockDerivativesService.generateDerivatives).not.toHaveBeenCalled();
    expect(worker.metrics.retried).toBe(1);
  });

  it('aborts with ack when virus scan is INFECTED or ERROR', async () => {
    vi.mocked(mockFileRepo.findById).mockResolvedValueOnce({
      ...sampleFile,
      scanStatus: 'INFECTED',
    });

    const outcome = await worker.handleProcess(sampleEnvelope, 0, 3);

    expect(outcome).toEqual({ kind: 'ack' });
    expect(mockDerivativesService.generateDerivatives).not.toHaveBeenCalled();
    expect(worker.metrics.skipped).toBe(1);
  });

  it('skips with ack when file is DELETED or QUARANTINED', async () => {
    vi.mocked(mockFileRepo.findById).mockResolvedValueOnce({
      ...sampleFile,
      status: 'DELETED',
    });

    const outcome = await worker.handleProcess(sampleEnvelope, 0, 3);

    expect(outcome).toEqual({ kind: 'ack' });
    expect(mockDerivativesService.generateDerivatives).not.toHaveBeenCalled();
    expect(worker.metrics.skipped).toBe(1);
  });

  it('skips non-derivable file types with ack', async () => {
    vi.mocked(mockDerivativesService.isDerivableImage).mockReturnValueOnce(
      false,
    );

    const outcome = await worker.handleProcess(sampleEnvelope, 0, 3);

    expect(outcome).toEqual({ kind: 'ack' });
    expect(mockDerivativesService.generateDerivatives).not.toHaveBeenCalled();
    expect(worker.metrics.skipped).toBe(1);
  });

  it('skips animated GIFs when 0 derivatives are returned', async () => {
    vi.mocked(mockDerivativesService.generateDerivatives).mockResolvedValueOnce(
      [],
    );

    const outcome = await worker.handleProcess(sampleEnvelope, 0, 3);

    expect(outcome).toEqual({ kind: 'ack' });
    expect(mockPrimaryDriver.upload).not.toHaveBeenCalled();
    expect(mockFileRepo.updateDerivatives).not.toHaveBeenCalled();
    expect(worker.metrics.skipped).toBe(1);
  });

  it('retries on primary driver download error within attempt limit', async () => {
    mockPrimaryDriver.downloadStream.mockRejectedValueOnce(
      new Error('S3 socket timeout'),
    );

    const outcome = await worker.handleProcess(sampleEnvelope, 1, 3);

    expect(outcome.kind).toBe('retry');
    expect(worker.metrics.retried).toBe(1);
  });

  it('routes to dead-letter on upload error when attempts exhausted', async () => {
    mockPrimaryDriver.upload.mockRejectedValueOnce(
      new Error('Permanent disk full error'),
    );

    const outcome = await worker.handleProcess(sampleEnvelope, 3, 3);

    expect(outcome.kind).toBe('dead-letter');
    expect(worker.metrics.errors).toBe(1);
  });
});
