/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HardDeleteService } from '../../src/files/hard-delete.service.js';
import type { DatabaseService } from '../../src/db/database.service.js';
import type { StorageRegistry } from '../../src/storage/registry.js';
import type { OutboxWriter } from '../../src/events/outbox-writer.js';
import type { UsageRepository } from '../../src/db/repositories/usage.repository.js';
import { NotFoundException } from '@nestjs/common';

describe('HardDeleteService [P6-07]', () => {
  let hardDeleteService: HardDeleteService;
  let mockDbService: DatabaseService;
  let mockStorageRegistry: StorageRegistry;
  let mockOutboxWriter: OutboxWriter;
  let mockDriver: any;
  let deletedStorageKeys: string[];
  let enqueuedEnvelopes: any[];

  beforeEach(() => {
    deletedStorageKeys = [];
    enqueuedEnvelopes = [];

    mockDriver = {
      delete: async (key: string) => {
        deletedStorageKeys.push(key);
      },
    };

    mockStorageRegistry = {
      has: () => true,
      get: () => mockDriver,
    } as any;

    mockOutboxWriter = {
      enqueue: async (_trx: any, envelope: any) => {
        enqueuedEnvelopes.push(envelope);
      },
    } as any;

    const mockDb = {
      selectFrom: (table: string) => ({
        select: () => ({
          where: (_col: string, _op: string, val: any) => ({
            executeTakeFirst: async () => {
              if (val === 'f-exist') {
                return {
                  id: 'f-exist',
                  tenant_id: 't-100',
                  namespace: 'esma-tenant',
                  status: 'ACTIVE',
                  size_bytes: '1024',
                };
              }
              return undefined;
            },
            execute: async () => [
              {
                provider: 'local',
                provider_key: 'local/key1.pdf',
                status: 'AVAILABLE',
              },
              {
                provider: 'seaweedfs',
                provider_key: 'seaweed/key2.pdf',
                status: 'AVAILABLE',
              },
            ],
          }),
        }),
      }),
      transaction: () => ({
        execute: async (callback: (trx: unknown) => Promise<unknown>) => {
          const trx = {
            deleteFrom: () => ({
              where: () => ({
                execute: async () => ({ numDeletedRows: 1n }),
              }),
            }),
          };
          return callback(trx);
        },
      }),
    };

    mockDbService = {
      getDb: () => mockDb,
    } as any;

    const mockUsageRepo = {
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as UsageRepository;

    hardDeleteService = new HardDeleteService(
      mockDbService,
      mockStorageRegistry,
      mockOutboxWriter,
      mockUsageRepo,
    );
  });

  it('purges physical storage replicas and enqueues file.erased audit event', async () => {
    const result = await hardDeleteService.hardDeleteFile({
      fileId: 'f-exist',
      operator: 'admin-tester',
      reason: 'GDPR Erasure Request',
    });

    expect(result.fileId).toBe('f-exist');
    expect(result.replicasDeleted).toBe(2);
    expect(result.dbRecordsDeleted).toBe(true);
    expect(result.auditEventEnqueued).toBe(true);

    expect(deletedStorageKeys).toEqual([
      { provider: 'local', key: 'local/key1.pdf' },
      { provider: 'seaweedfs', key: 'seaweed/key2.pdf' },
    ]);

    expect(enqueuedEnvelopes.length).toBe(1);
    expect(enqueuedEnvelopes[0].eventType).toBe('file.erased');
    expect(enqueuedEnvelopes[0].payload.reason).toBe('GDPR Erasure Request');
  });

  it('throws NotFoundException if target file does not exist', async () => {
    await expect(
      hardDeleteService.hardDeleteFile({ fileId: 'f-non-existent' }),
    ).rejects.toThrow(NotFoundException);
  });
});
