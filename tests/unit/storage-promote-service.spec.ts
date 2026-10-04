/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StoragePromoteService } from '../../src/storage/storage-promote.service.js';
import type { DatabaseService } from '../../src/db/database.service.js';

describe('StoragePromoteService [P6-07]', () => {
  let promoteService: StoragePromoteService;
  let mockDb: any;
  let mockDbService: DatabaseService;
  let filesStore: any[];
  let replicasStore: any[];

  beforeEach(() => {
    filesStore = [
      {
        id: 'file-1',
        primary_provider: 'local',
        namespace: 'esma-tenant',
        status: 'ACTIVE',
        created_at: new Date(),
      },
      {
        id: 'file-2',
        primary_provider: 'local',
        namespace: 'esma-tenant',
        status: 'ACTIVE',
        created_at: new Date(),
      },
    ];

    replicasStore = [
      {
        file_id: 'file-1',
        provider: 'local',
        role: 'primary',
        status: 'AVAILABLE',
      },
      {
        file_id: 'file-1',
        provider: 'seaweedfs',
        role: 'secondary',
        status: 'AVAILABLE',
      },
      {
        file_id: 'file-2',
        provider: 'local',
        role: 'primary',
        status: 'AVAILABLE',
      },
      {
        file_id: 'file-2',
        provider: 'seaweedfs',
        role: 'secondary',
        status: 'QUEUED', // Not available
      },
    ];

    mockDb = {
      selectFrom: (table: string) => {
        if (table === 'files') {
          let wherePrimaryOp: string | null = null;
          let wherePrimaryVal: any = null;
          let afterId: string | null = null;

          const queryObj: any = {
            where: (col: string, op: string, val: any) => {
              if (col === 'primary_provider') {
                wherePrimaryOp = op;
                wherePrimaryVal = val;
              } else if (col === 'id' && op === '>') {
                afterId = val;
              }
              return queryObj;
            },
            orderBy: () => queryObj,
            limit: (n: number) => ({
              execute: async () => {
                let res = filesStore.filter((f) => f.status === 'ACTIVE');
                if (wherePrimaryOp === '=') {
                  res = res.filter((f) => f.primary_provider === wherePrimaryVal);
                } else if (wherePrimaryOp === '!=') {
                  res = res.filter((f) => f.primary_provider !== wherePrimaryVal);
                }
                if (afterId !== null) {
                  const currentAfterId = afterId;
                  res = res.filter((f) => f.id > currentAfterId);
                }
                return res.slice(0, n);
              },
            }),
          };
          return { select: () => queryObj };
        }
        if (table === 'file_replicas') {
          return {
            select: () => ({
              where: (col: string, op: string, val: any) => ({
                execute: async () =>
                  replicasStore.filter((r) => r.file_id === val),
              }),
            }),
          };
        }
        return {};
      },
      transaction: () => ({
        execute: async (callback: any) => {
          const trx = {
            updateTable: (table: string) => ({
              set: (data: any) => ({
                where: (col1: string, op1: string, val1: any) => ({
                  where: (col2?: string, op2?: string, val2?: any) => ({
                    execute: async () => {
                      if (table === 'files') {
                        const file = filesStore.find((f) => f.id === val1);
                        if (file) file.primary_provider = data.primary_provider;
                      } else if (table === 'file_replicas') {
                        const rep = replicasStore.find(
                          (r) =>
                            r.file_id === val1 &&
                            (val2 ? r.role === val2 || r.provider === val2 : true),
                        );
                        if (rep) rep.role = data.role;
                      }
                    },
                  }),
                  execute: async () => {
                    if (table === 'files') {
                      const file = filesStore.find((f) => f.id === val1);
                      if (file) file.primary_provider = data.primary_provider;
                    }
                  },
                }),
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

    promoteService = new StoragePromoteService(mockDbService);
  });

  it('promotes primary provider when target replica is AVAILABLE', async () => {
    const result = await promoteService.promotePrimary({
      toProvider: 'seaweedfs',
      fromProvider: 'local',
      dryRun: false,
    });

    expect(result.scanned).toBe(2);
    expect(result.promoted).toBe(1); // file-1 promoted
    expect(result.skippedNotAvailable).toBe(1); // file-2 skipped because seaweedfs is QUEUED
    expect(filesStore[0].primary_provider).toBe('seaweedfs');
  });

  it('previews promotion without mutating database in dry-run mode', async () => {
    const result = await promoteService.promotePrimary({
      toProvider: 'seaweedfs',
      dryRun: true,
    });

    expect(result.scanned).toBe(2);
    expect(result.promoted).toBe(1);
    expect(filesStore[0].primary_provider).toBe('local'); // Unchanged
  });
});
