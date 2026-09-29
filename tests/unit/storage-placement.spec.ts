import { beforeEach, describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import type { RequestContext } from '../../src/auth/context.js';
import type { AppConfigService } from '../../src/config/config.service.js';
import type { UploadPolicy, Visibility } from '../../src/config/policies.js';
import { StorageUnavailableError } from '../../src/core/errors/app-error.js';
import { StoragePlacementService } from '../../src/storage/placement.service.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { FakeStorageDriver } from '../helpers/storage-driver.mock.js';

describe('StoragePlacementService Unit & Property Tests (P4-01)', () => {
  const mockCtx: RequestContext = {
    correlationId: 'test-corr-id',
    namespace: 'generic',
    tenantId: 'tenant-123',
    actor: {
      id: 'actor-1',
      roles: ['admin'],
    },
    authenticated: true,
  };

  const createMockConfig = (
    overrides?: Partial<AppConfigService>,
  ): AppConfigService =>
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
      ...overrides,
    }) as unknown as AppConfigService;

  const createBasePolicy = (
    overrides?: Partial<UploadPolicy>,
  ): UploadPolicy => ({
    namespace: 'generic',
    maxFileSizeBytes: 50 * 1024 * 1024,
    maxFilesPerRequest: 10,
    allowedMimeTypes: ['image/png', 'image/jpeg', 'application/pdf'],
    defaultVisibility: 'public',
    allowedVisibilities: ['public', 'tenant', 'private'],
    cloudinaryReplication: 'public-only',
    cloudinaryRootFolder: 'uploads',
    requireVirusScan: false,
    ...overrides,
  });

  let registry: StorageRegistry;
  let placementService: StoragePlacementService;
  let seaweedDriver: FakeStorageDriver;
  let localDriver: FakeStorageDriver;
  let cloudinaryDriver: FakeStorageDriver;

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
      maxObjectBytes: 50 * 1024 * 1024, // 50MB
    };

    localDriver = new FakeStorageDriver('local');
    localDriver.capabilities = {
      rangeReads: true,
      presignedUrls: false,
      publicCdn: false,
      imageTransforms: false,
      privateDelivery: true,
      maxObjectBytes: 100 * 1024 * 1024, // 100MB
    };

    cloudinaryDriver = new FakeStorageDriver('cloudinary');
    cloudinaryDriver.capabilities = {
      rangeReads: true,
      presignedUrls: false,
      publicCdn: true,
      imageTransforms: true,
      privateDelivery: false, // Default: public CDN only
      maxObjectBytes: 10 * 1024 * 1024, // 10MB
    };

    registry.register(seaweedDriver);
    registry.register(localDriver);
    registry.register(cloudinaryDriver);
    registry.validateConfiguration();

    placementService = new StoragePlacementService(registry);
  });

  describe('Primary Candidate Selection & Failover', () => {
    it('selects healthy primary and orders failovers', () => {
      const plan = placementService.plan(mockCtx, createBasePolicy(), {
        size: 1024 * 1024,
        visibility: 'public',
      });

      expect(plan.primaryCandidates).toEqual(['seaweedfs', 'local']);
      expect(plan.secondaries).toEqual(['cloudinary']);
    });

    it('bypasses primary if primary is unhealthy and falls back to failover', () => {
      // Simulate seaweedfs being down in healthCache
      const internalRegistry = registry as unknown as {
        healthCache: Map<
          string,
          { ok: boolean; latencyMs: number; detail: string }
        >;
      };
      internalRegistry.healthCache.set('seaweedfs', {
        ok: false,
        latencyMs: -1,
        detail: 'Connection refused',
      });

      const plan = placementService.plan(mockCtx, createBasePolicy(), {
        size: 1024 * 1024,
        visibility: 'public',
      });

      expect(plan.primaryCandidates).toEqual(['local']);
      expect(plan.secondaries).toEqual(['cloudinary']);
    });

    it('bypasses primary if file size exceeds primary maxObjectBytes', () => {
      // File size 60MB exceeds seaweedfs maxObjectBytes (50MB) but fits local (100MB)
      const plan = placementService.plan(mockCtx, createBasePolicy(), {
        size: 60 * 1024 * 1024,
        visibility: 'public',
      });

      expect(plan.primaryCandidates).toEqual(['local']);
      // Cloudinary maxObjectBytes is 10MB, so it should also be excluded from secondaries
      expect(plan.secondaries).toEqual([]);
    });

    it('throws StorageUnavailableError when all primary candidates are filtered out', () => {
      // File size 150MB exceeds both seaweedfs (50MB) and local (100MB)
      expect(() =>
        placementService.plan(mockCtx, createBasePolicy(), {
          size: 150 * 1024 * 1024,
          visibility: 'public',
        }),
      ).toThrow(StorageUnavailableError);
    });

    it('honors policy.storage.primary override as first candidate', () => {
      const policyWithOverride = createBasePolicy({
        storage: {
          primary: 'local',
        },
      });

      const plan = placementService.plan(mockCtx, policyWithOverride, {
        size: 1024 * 1024,
        visibility: 'public',
      });

      expect(plan.primaryCandidates).toEqual(['local', 'seaweedfs']);
      expect(plan.secondaries).toEqual(['cloudinary']);
    });
  });

  describe('Secondary Replication Target Filtering', () => {
    it('excludes primary candidates from secondaries', () => {
      const plan = placementService.plan(mockCtx, createBasePolicy(), {
        size: 1024 * 1024,
        visibility: 'public',
      });

      expect(plan.primaryCandidates).toContain('seaweedfs');
      expect(plan.primaryCandidates).toContain('local');
      expect(plan.secondaries).not.toContain('seaweedfs');
      expect(plan.secondaries).not.toContain('local');
    });

    it('excludes secondaries exceeding maxObjectBytes', () => {
      // Cloudinary limit is 10MB; 15MB file should exclude Cloudinary
      const plan = placementService.plan(mockCtx, createBasePolicy(), {
        size: 15 * 1024 * 1024,
        visibility: 'public',
      });

      expect(plan.secondaries).not.toContain('cloudinary');
    });

    it('expands auto replicas to configured healthy drivers minus primary candidates', () => {
      const policyAuto = createBasePolicy({
        storage: {
          replicas: 'auto',
        },
      });

      const plan = placementService.plan(mockCtx, policyAuto, {
        size: 1024 * 1024,
        visibility: 'public',
      });

      expect(plan.secondaries).toEqual(['cloudinary']);
    });
  });

  describe('Cloudinary Replication Policy Rules', () => {
    it('excludes Cloudinary when policy.cloudinaryReplication is "never"', () => {
      const policy = createBasePolicy({
        cloudinaryReplication: 'never',
      });

      const plan = placementService.plan(mockCtx, policy, {
        size: 1024 * 1024,
        visibility: 'public',
      });

      expect(plan.secondaries).not.toContain('cloudinary');
    });

    it('includes Cloudinary for public files when policy.cloudinaryReplication is "public-only"', () => {
      const policy = createBasePolicy({
        cloudinaryReplication: 'public-only',
      });

      const plan = placementService.plan(mockCtx, policy, {
        size: 1024 * 1024,
        visibility: 'public',
      });

      expect(plan.secondaries).toContain('cloudinary');
    });

    it('excludes Cloudinary for private or tenant files when policy.cloudinaryReplication is "public-only"', () => {
      const policy = createBasePolicy({
        cloudinaryReplication: 'public-only',
      });

      const planPrivate = placementService.plan(mockCtx, policy, {
        size: 1024 * 1024,
        visibility: 'private',
      });
      expect(planPrivate.secondaries).not.toContain('cloudinary');

      const planTenant = placementService.plan(mockCtx, policy, {
        size: 1024 * 1024,
        visibility: 'tenant',
      });
      expect(planTenant.secondaries).not.toContain('cloudinary');
    });

    it('allows Cloudinary for private files under "always" only if privateDelivery is true', () => {
      const policy = createBasePolicy({
        cloudinaryReplication: 'always',
      });

      // Default: privateDelivery is false -> excluded
      const planNoPrivate = placementService.plan(mockCtx, policy, {
        size: 1024 * 1024,
        visibility: 'private',
      });
      expect(planNoPrivate.secondaries).not.toContain('cloudinary');

      // Enable privateDelivery on Cloudinary -> allowed
      cloudinaryDriver.capabilities.privateDelivery = true;
      const planWithPrivate = placementService.plan(mockCtx, policy, {
        size: 1024 * 1024,
        visibility: 'private',
      });
      expect(planWithPrivate.secondaries).toContain('cloudinary');
    });
  });

  describe('Security Invariants & Property-Based Tests (fast-check)', () => {
    it('Property test: for any policy, size and non-public visibility, a public-CDN driver without privateDelivery is never planned', () => {
      fc.assert(
        fc.property(
          fc.constantFrom<Visibility>('private', 'tenant'),
          fc.integer({ min: 1, max: 20 * 1024 * 1024 }),
          fc.constantFrom<'never' | 'public-only' | 'always'>(
            'never',
            'public-only',
            'always',
          ),
          fc.boolean(),
          (visibility, size, cloudinaryReplication, allowPrivateDelivery) => {
            cloudinaryDriver.capabilities.privateDelivery =
              allowPrivateDelivery;

            const policy = createBasePolicy({
              cloudinaryReplication,
            });

            try {
              const plan = placementService.plan(mockCtx, policy, {
                size,
                visibility,
              });

              // If privateDelivery is false, Cloudinary MUST NEVER appear in primary or secondaries
              if (!allowPrivateDelivery) {
                expect(plan.primaryCandidates).not.toContain('cloudinary');
                expect(plan.secondaries).not.toContain('cloudinary');
              }
            } catch (err: unknown) {
              // StorageUnavailableError is allowed if no candidates fit
              expect(err).toBeInstanceOf(StorageUnavailableError);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
