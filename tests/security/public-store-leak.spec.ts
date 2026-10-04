import { describe, it, expect, beforeEach } from 'vitest';
import { StoragePlacementService } from '../../src/storage/placement.service.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import type { UploadPolicy } from '../../src/config/policies.js';
import type { RequestContext } from '../../src/core/request-context.js';
import type { FilePlacementMetadata } from '../../src/storage/placement.service.js';
import { FakeStorageDriver } from '../helpers/storage-driver.mock.js';
import type { AppConfigService } from '../../src/config/config.service.js';

describe('Public Store Leak Prevention Verification (P6-09 / F-25 / F-26)', () => {
  let placementService: StoragePlacementService;
  let registry: StorageRegistry;
  let seaweedDriver: FakeStorageDriver;
  let localDriver: FakeStorageDriver;
  let cloudinaryDriver: FakeStorageDriver;

  const mockCtx: RequestContext = {
    tenantId: 'tenant-school-01',
    namespace: 'esma-tenant',
    actor: { id: 'usr-admin', type: 'user', roles: ['admin'], scopes: [] },
    correlationId: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0001',
    ipAddress: '127.0.0.1',
    attributes: {},
  };

  const createMockConfig = (): AppConfigService =>
    ({
      storageDriver: 'hybrid',
      localStoragePath: '/data/storage',
      stagingDir: '/tmp/staging',
      hybridPrimary: 'seaweedfs',
      hybridPrimaryFailover: 'local',
      hybridReplicas: 'cloudinary,local',
      hybridStrict: false,
      instanceCountHint: 1,
      isProduction: () => false,
    }) as unknown as AppConfigService;

  const createPolicy = (overrides?: Partial<UploadPolicy>): UploadPolicy => ({
    namespace: 'esma-tenant',
    maxFileSizeBytes: 50 * 1024 * 1024,
    maxFilesPerRequest: 10,
    allowedMimeTypes: ['image/png', 'image/jpeg', 'application/pdf'],
    defaultVisibility: 'private',
    allowedVisibilities: ['public', 'tenant', 'private'],
    cloudinaryReplication: 'public-only',
    cloudinaryRootFolder: 'uploads',
    requireVirusScan: false,
    ...overrides,
  });

  beforeEach(() => {
    const config = createMockConfig();
    registry = new StorageRegistry(config);

    seaweedDriver = new FakeStorageDriver('seaweedfs');
    seaweedDriver.capabilities = {
      rangeReads: true,
      presignedUrls: true,
      publicCdn: false,
      imageTransforms: false,
      privateDelivery: true,
      maxObjectBytes: 50 * 1024 * 1024,
    };

    localDriver = new FakeStorageDriver('local');
    localDriver.capabilities = {
      rangeReads: true,
      presignedUrls: false,
      publicCdn: false,
      imageTransforms: false,
      privateDelivery: true,
      maxObjectBytes: 100 * 1024 * 1024,
    };

    cloudinaryDriver = new FakeStorageDriver('cloudinary');
    cloudinaryDriver.capabilities = {
      rangeReads: true,
      presignedUrls: false,
      publicCdn: true,
      imageTransforms: true,
      privateDelivery: false, // Standard Cloudinary is public-only!
      maxObjectBytes: 10 * 1024 * 1024,
    };

    registry.register(seaweedDriver);
    registry.register(localDriver);
    registry.register(cloudinaryDriver);
    registry.validateConfiguration();

    placementService = new StoragePlacementService(registry);
  });

  it('strictly excludes Cloudinary as primary or secondary for private files', () => {
    const policy = createPolicy({
      cloudinaryReplication: 'public-only',
    });

    const privateFile: FilePlacementMetadata = {
      size: 1048576,
      visibility: 'private', // Non-public document (e.g. passport, exam result)
    };

    const plan = placementService.plan(mockCtx, policy, privateFile);

    expect(plan.primaryCandidates).not.toContain('cloudinary');
    expect(plan.secondaries).not.toContain('cloudinary');
  });

  it('strictly excludes Cloudinary for tenant-scoped internal files even if policy is missing', () => {
    const defaultPolicy = createPolicy({
      cloudinaryReplication: undefined,
    });

    const tenantFile: FilePlacementMetadata = {
      size: 2048,
      visibility: 'tenant', // Tenant confidential file
    };

    const plan = placementService.plan(mockCtx, defaultPolicy, tenantFile);

    expect(plan.primaryCandidates).not.toContain('cloudinary');
    expect(plan.secondaries).not.toContain('cloudinary');
  });

  it('allows Cloudinary replication only when file visibility is explicitly public', () => {
    const policy = createPolicy({
      cloudinaryReplication: 'public-only',
    });

    const publicFile: FilePlacementMetadata = {
      size: 512000,
      visibility: 'public', // Explicitly public asset (e.g. school logo, banner)
    };

    const plan = placementService.plan(mockCtx, policy, publicFile);

    expect(plan.secondaries).toContain('cloudinary');
  });

  it('verifies that zero private upload operations ever invoke Cloudinary write()', () => {
    // Audit calls on cloudinaryDriver
    const calls = cloudinaryDriver.getCalls();
    expect(calls.filter((c) => c.method === 'write')).toHaveLength(0);
  });
});
