import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReplicaSelector } from '../../src/files/replica-selector.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { ReplicaNotAvailableError } from '../../src/core/errors/app-error.js';
import type { FileRecord, FileReplica } from '../../src/core/types.js';
import type { ProviderName } from '../../src/storage/types.js';

describe('ReplicaSelector Unit Tests [P4-08]', () => {
  let selector: ReplicaSelector;
  let registry: StorageRegistry;
  let healthyProviders: Set<ProviderName>;
  let registeredProviders: Set<ProviderName>;
  let driverCapabilities: Record<
    string,
    { privateDelivery?: boolean; publicCdn?: boolean }
  >;

  const baseFile: FileRecord = {
    id: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0001',
    namespace: 'esma-tenant',
    tenantId: 'school-100',
    subTenantId: 'branch-A',
    folder: 'documents',
    storageKey: 'uploads/schools/school-100/test.pdf',
    originalFilename: 'test.pdf',
    mimetype: 'application/pdf',
    declaredMimetype: 'application/pdf',
    sizeBytes: 1024n,
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    visibility: 'tenant',
    status: 'ACTIVE',
    scanStatus: 'CLEAN',
    replicationStatus: 'SYNCED',
    primaryProvider: 'seaweedfs',
    uploadedBy: 'user-1',
    tags: [],
    attributes: {},
    legacyPublicId: null,
    idempotencyKey: null,
    correlationId: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0000',
    version: 1,
    createdAt: new Date('2026-09-20T10:00:00Z'),
    updatedAt: new Date('2026-09-20T10:00:00Z'),
    deletedAt: null,
  };

  const createReplica = (
    provider: ProviderName,
    role: 'primary' | 'secondary',
    status:
      | 'AVAILABLE'
      | 'QUEUED'
      | 'IN_PROGRESS'
      | 'FAILED'
      | 'DELETED' = 'AVAILABLE',
  ): FileReplica => ({
    fileId: baseFile.id,
    provider,
    role,
    status,
    providerKey: `uploads/${provider}/test.pdf`,
    providerMeta: {},
    url: null,
    etag: null,
    attempts: 0,
    lastError: null,
    syncedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  beforeEach(() => {
    healthyProviders = new Set<ProviderName>([
      'seaweedfs',
      'local',
      'cloudinary',
    ]);
    registeredProviders = new Set<ProviderName>([
      'seaweedfs',
      'local',
      'cloudinary',
    ]);
    driverCapabilities = {
      seaweedfs: { privateDelivery: true, publicCdn: false },
      local: { privateDelivery: true, publicCdn: false },
      cloudinary: { privateDelivery: false, publicCdn: true },
    };

    registry = {
      has: vi.fn((p: ProviderName) => registeredProviders.has(p)),
      isHealthy: vi.fn((p: ProviderName) => healthyProviders.has(p)),
      get: vi.fn((p: ProviderName) => ({
        name: p,
        capabilities: driverCapabilities[p] ?? {},
      })),
    } as unknown as StorageRegistry;

    selector = new ReplicaSelector(registry);
  });

  describe('Truth-table preference order', () => {
    it('public file with redirectAllowed: prefers CDN (Cloudinary) first, then primary, then other secondaries', () => {
      const publicFile: FileRecord = { ...baseFile, visibility: 'public' };
      const replicas: FileReplica[] = [
        createReplica('local', 'secondary', 'AVAILABLE'),
        createReplica('seaweedfs', 'primary', 'AVAILABLE'),
        createReplica('cloudinary', 'secondary', 'AVAILABLE'),
      ];

      const candidates = selector.selectCandidates(publicFile, replicas, {
        redirectAllowed: true,
      });

      expect(candidates.map((c) => c.provider)).toEqual([
        'cloudinary',
        'seaweedfs',
        'local',
      ]);
      expect(
        selector.choose(publicFile, replicas, { redirectAllowed: true })
          ?.provider,
      ).toBe('cloudinary');
    });

    it('public file with redirectAllowed=false: prefers primary first, then other secondaries, CDN last', () => {
      const publicFile: FileRecord = { ...baseFile, visibility: 'public' };
      const replicas: FileReplica[] = [
        createReplica('cloudinary', 'secondary', 'AVAILABLE'),
        createReplica('local', 'secondary', 'AVAILABLE'),
        createReplica('seaweedfs', 'primary', 'AVAILABLE'),
      ];

      const candidates = selector.selectCandidates(publicFile, replicas, {
        redirectAllowed: false,
      });

      expect(candidates.map((c) => c.provider)).toEqual([
        'seaweedfs',
        'local',
        'cloudinary',
      ]);
    });

    it('non-public file (tenant): prefers primary first, then internal secondaries, excludes public CDN', () => {
      const tenantFile: FileRecord = { ...baseFile, visibility: 'tenant' };
      const replicas: FileReplica[] = [
        createReplica('cloudinary', 'secondary', 'AVAILABLE'),
        createReplica('local', 'secondary', 'AVAILABLE'),
        createReplica('seaweedfs', 'primary', 'AVAILABLE'),
      ];

      const candidates = selector.selectCandidates(tenantFile, replicas);

      // Cloudinary has privateDelivery: false, so it must be excluded
      expect(candidates.map((c) => c.provider)).toEqual(['seaweedfs', 'local']);
      expect(selector.choose(tenantFile, replicas)?.provider).toBe('seaweedfs');
    });

    it('non-public file (private): includes CDN if driver reports privateDelivery capability', () => {
      driverCapabilities['cloudinary'] = {
        privateDelivery: true,
        publicCdn: true,
      };
      const privateFile: FileRecord = { ...baseFile, visibility: 'private' };
      const replicas: FileReplica[] = [
        createReplica('cloudinary', 'secondary', 'AVAILABLE'),
        createReplica('seaweedfs', 'primary', 'AVAILABLE'),
      ];

      const candidates = selector.selectCandidates(privateFile, replicas);
      expect(candidates.map((c) => c.provider)).toEqual([
        'seaweedfs',
        'cloudinary',
      ]);
    });
  });

  describe('Health and Status Filtering', () => {
    it('skips replicas that are not AVAILABLE (e.g. QUEUED, IN_PROGRESS, FAILED)', () => {
      const tenantFile: FileRecord = { ...baseFile, visibility: 'tenant' };
      const replicas: FileReplica[] = [
        createReplica('seaweedfs', 'primary', 'IN_PROGRESS'),
        createReplica('local', 'secondary', 'AVAILABLE'),
      ];

      const candidates = selector.selectCandidates(tenantFile, replicas);
      expect(candidates.map((c) => c.provider)).toEqual(['local']);
    });

    it('skips primary if primary driver is unhealthy, falling back to healthy secondary', () => {
      healthyProviders.delete('seaweedfs'); // Mark primary unhealthy

      const tenantFile: FileRecord = { ...baseFile, visibility: 'tenant' };
      const replicas: FileReplica[] = [
        createReplica('seaweedfs', 'primary', 'AVAILABLE'),
        createReplica('local', 'secondary', 'AVAILABLE'),
      ];

      const candidates = selector.selectCandidates(tenantFile, replicas);
      expect(candidates.map((c) => c.provider)).toEqual(['local']);
      expect(selector.choose(tenantFile, replicas)?.provider).toBe('local');
    });

    it('returns empty array when no replicas are available or healthy', () => {
      healthyProviders.clear();
      const replicas: FileReplica[] = [
        createReplica('seaweedfs', 'primary', 'AVAILABLE'),
      ];

      const candidates = selector.selectCandidates(baseFile, replicas);
      expect(candidates).toEqual([]);
      expect(selector.choose(baseFile, replicas)).toBeNull();
    });
  });

  describe('Virtual Primary Synthesis (single-driver / legacy files)', () => {
    it('synthesizes primary replica when replicas table is empty and primary driver is healthy', () => {
      const candidates = selector.selectCandidates(baseFile, []);

      expect(candidates.length).toBe(1);
      expect(candidates[0].provider).toBe('seaweedfs');
      expect(candidates[0].role).toBe('primary');
      expect(candidates[0].status).toBe('AVAILABLE');
      expect(candidates[0].providerKey).toBe(baseFile.storageKey);
    });

    it('does not synthesize primary replica if primary driver is unhealthy', () => {
      healthyProviders.delete('seaweedfs');
      const candidates = selector.selectCandidates(baseFile, []);
      expect(candidates).toEqual([]);
    });
  });

  describe('Admin Preferred Provider (?provider=x)', () => {
    it('returns the requested provider replica when AVAILABLE and healthy', () => {
      const replicas: FileReplica[] = [
        createReplica('seaweedfs', 'primary', 'AVAILABLE'),
        createReplica('local', 'secondary', 'AVAILABLE'),
      ];

      const candidates = selector.selectCandidates(baseFile, replicas, {
        preferredProvider: 'local',
      });

      expect(candidates.length).toBe(1);
      expect(candidates[0].provider).toBe('local');
    });

    it('throws ReplicaNotAvailableError with 409 and Retry-After: 30 if requested provider is missing', () => {
      const replicas: FileReplica[] = [
        createReplica('seaweedfs', 'primary', 'AVAILABLE'),
      ];

      try {
        selector.selectCandidates(baseFile, replicas, {
          preferredProvider: 'local',
        });
        expect.fail('Should have thrown ReplicaNotAvailableError');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ReplicaNotAvailableError);
        const headers = (err as { headers?: Record<string, string> }).headers;
        expect(headers?.['Retry-After']).toBe('30');
      }
    });

    it('throws ReplicaNotAvailableError if requested provider is unhealthy', () => {
      healthyProviders.delete('local');
      const replicas: FileReplica[] = [
        createReplica('seaweedfs', 'primary', 'AVAILABLE'),
        createReplica('local', 'secondary', 'AVAILABLE'),
      ];

      expect(() =>
        selector.selectCandidates(baseFile, replicas, {
          preferredProvider: 'local',
        }),
      ).toThrow(ReplicaNotAvailableError);
    });
  });
});
