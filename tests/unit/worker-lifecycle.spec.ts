/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-call */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { WorkerService } from '../../src/workers/worker.service.js';
import { createWorkerHealthServer } from '../../src/worker.js';
import type { StructuredLogger } from '../../src/observability/logger.service.js';
import type { DatabaseService } from '../../src/db/database.service.js';
import type { AppConfigService } from '../../src/config/config.service.js';
import type { OutboxRelay } from '../../src/events/outbox-relay.js';
import type { OutboxRetentionService } from '../../src/events/outbox-retention.service.js';
import type { ReplicationWorker } from '../../src/workers/replication.worker.js';
import type { HealthService } from '../../src/observability/health.service.js';

describe('Worker Lifecycle & Health Server (P4-07)', () => {
  let mockLogger: StructuredLogger;
  let mockDb: DatabaseService;
  let mockConfig: AppConfigService;
  let mockRelay: OutboxRelay;
  let mockRetention: OutboxRetentionService;
  let mockReplicationWorker: ReplicationWorker;
  let mockHealthService: HealthService;

  beforeEach(() => {
    mockLogger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as StructuredLogger;

    mockDb = {
      ping: vi.fn().mockResolvedValue(true),
    } as unknown as DatabaseService;

    mockConfig = {
      workerRoles: 'relay,replication',
      workerHealthPort: 0,
    } as unknown as AppConfigService;

    mockRelay = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    } as unknown as OutboxRelay;

    mockRetention = {
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as OutboxRetentionService;

    mockReplicationWorker = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReplicationWorker;

    mockHealthService = {
      live: vi.fn().mockReturnValue({ status: 'ok' }),
      ready: vi.fn().mockResolvedValue({
        status: 'ok',
        checks: {
          stagingDir: { status: 'ok' },
          storageConfig: { status: 'ok' },
        },
      }),
      drivers: vi.fn().mockReturnValue({
        status: 'ok',
        topology: { primary: 'seaweedfs', secondaries: ['local'] },
        drivers: {
          seaweedfs: { ok: true, latencyMs: 5 },
          local: { ok: true, latencyMs: 1 },
        },
      }),
    } as unknown as HealthService;
  });

  it('starts configured roles (relay and replication) on bootstrap and stops on shutdown', async () => {
    const mockScanWorker = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    } as any;

    const mockSweeperService = {
      start: vi.fn(),
      stop: vi.fn(),
    } as any;

    const mockDlqWorker = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    } as any;

    const workerService = new WorkerService(
      mockLogger,
      mockDb,
      mockConfig,
      mockRelay,
      mockRetention,
      mockReplicationWorker,
      mockScanWorker,
      mockSweeperService,
      mockDlqWorker,
    );

    await workerService.onApplicationBootstrap();

    expect(mockDb.ping).toHaveBeenCalled();
    expect(mockRelay.start).toHaveBeenCalled();
    expect(mockRetention.start).toHaveBeenCalled();
    expect(mockReplicationWorker.start).toHaveBeenCalled();

    const roles = workerService.getRunningRoles();
    expect(roles).toContain('relay');
    expect(roles).toContain('replication');

    // Shutdown
    workerService.onApplicationShutdown('SIGTERM');
    expect(mockRelay.stop).toHaveBeenCalled();
    expect(mockRetention.stop).toHaveBeenCalled();
    expect(mockReplicationWorker.stop).toHaveBeenCalled();
  });

  it('starts and stops ScanWorker when processing role is configured (P5-07)', async () => {
    const processingConfig = {
      workerRoles: 'processing',
      workerHealthPort: 0,
    } as unknown as AppConfigService;

    const mockScanWorker = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    } as any;

    const mockSweeperService = {
      start: vi.fn(),
      stop: vi.fn(),
    } as any;

    const mockDlqWorker = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    } as any;

    const workerService = new WorkerService(
      mockLogger,
      mockDb,
      processingConfig,
      mockRelay,
      mockRetention,
      mockReplicationWorker,
      mockScanWorker,
      mockSweeperService,
      mockDlqWorker,
    );

    await workerService.onApplicationBootstrap();
    expect(mockScanWorker.start).toHaveBeenCalled();
    expect(workerService.getRunningRoles()).toContain('processing');

    workerService.onApplicationShutdown('SIGTERM');
    expect(mockScanWorker.stop).toHaveBeenCalled();
  });

  it('starts and stops DlqWorker when dlq role is configured (P5-06)', async () => {
    const dlqConfig = {
      workerRoles: 'dlq',
      workerHealthPort: 0,
    } as unknown as AppConfigService;

    const mockScanWorker = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    } as any;

    const mockSweeperService = {
      start: vi.fn(),
      stop: vi.fn(),
    } as any;

    const mockDlqWorker = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    } as any;

    const workerService = new WorkerService(
      mockLogger,
      mockDb,
      dlqConfig,
      mockRelay,
      mockRetention,
      mockReplicationWorker,
      mockScanWorker,
      mockSweeperService,
      mockDlqWorker,
    );

    await workerService.onApplicationBootstrap();
    expect(mockDlqWorker.start).toHaveBeenCalled();
    expect(workerService.getRunningRoles()).toContain('dlq');

    workerService.onApplicationShutdown('SIGTERM');
    expect(mockDlqWorker.stop).toHaveBeenCalled();
  });

  describe('createWorkerHealthServer', () => {
    let server: http.Server;
    let port: number;

    const request = (
      path: string,
      method = 'GET',
    ): Promise<{ status: number; body: any }> => {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path,
            method,
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => {
              data += chunk;
            });
            res.on('end', () => {
              try {
                resolve({
                  status: res.statusCode ?? 500,
                  body: JSON.parse(data),
                });
              } catch {
                resolve({
                  status: res.statusCode ?? 500,
                  body: data,
                });
              }
            });
          },
        );
        req.on('error', reject);
        req.end();
      });
    };

    beforeEach(async () => {
      // Port 0 lets OS allocate an available port
      server = await createWorkerHealthServer(mockHealthService, 0, mockLogger);
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        port = addr.port;
      }
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    it('responds 200 on /health/live', async () => {
      const res = await request('/health/live');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('responds 200 on /health/ready when healthy', async () => {
      const res = await request('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('responds 503 on /health/ready when unhealthy', async () => {
      (mockHealthService.ready as any).mockResolvedValueOnce({
        status: 'error',
        checks: {
          stagingDir: { status: 'error', message: 'not writable' },
          storageConfig: { status: 'ok' },
        },
      });

      const res = await request('/health/ready');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('error');
    });

    it('responds 200 on /health/drivers', async () => {
      const res = await request('/health/drivers');
      expect(res.status).toBe(200);
      expect(res.body.topology.primary).toBe('seaweedfs');
    });

    it('responds 404 on unknown route', async () => {
      const res = await request('/unknown');
      expect(res.status).toBe(404);
    });

    it('responds 405 on non-GET methods', async () => {
      const res = await request('/health/live', 'POST');
      expect(res.status).toBe(405);
    });
  });
});
