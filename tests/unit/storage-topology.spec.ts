import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../../src/config/config.service.js';
import { PermanentError } from '../../src/core/errors/app-error.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { resolveTopology } from '../../src/storage/topology.js';
import { FakeStorageDriver } from '../helpers/storage-driver.mock.js';

describe('Storage Topology Resolution and Registry Validation Tests (P4-01)', () => {
  const createMockConfig = (
    overrides?: Partial<AppConfigService>,
  ): AppConfigService =>
    ({
      storageDriver: 'hybrid',
      localStoragePath: '/data/storage',
      stagingDir: '/tmp/staging',
      cloudinaryCloudName: 'test-cloud',
      cloudinaryApiKey: 'key',
      cloudinaryApiSecret: 'secret',
      cloudinaryRootFolder: 'uploads',
      cloudinaryMaxObjectBytes: 10485760,
      seaweedfsS3Endpoint: 'http://localhost:8333',
      seaweedfsBucket: 'test-bucket',
      seaweedfsAccessKey: 's3-key',
      seaweedfsSecretKey: 's3-secret',
      hybridPrimary: 'seaweedfs',
      hybridPrimaryFailover: 'local',
      hybridReplicas: 'cloudinary,local',
      hybridStrict: true,
      instanceCountHint: 1,
      isProduction: () => false,
      ...overrides,
    }) as unknown as AppConfigService;

  describe('resolveTopology truth-table tests', () => {
    it('resolves single mode for local, cloudinary, and seaweedfs', () => {
      const localTopo = resolveTopology(
        createMockConfig({ storageDriver: 'local' }),
      );
      expect(localTopo).toEqual({
        mode: 'single',
        primary: 'local',
        primaryFailover: [],
        secondaries: [],
        strict: true,
      });

      const cloudTopo = resolveTopology(
        createMockConfig({ storageDriver: 'cloudinary' }),
      );
      expect(cloudTopo).toEqual({
        mode: 'single',
        primary: 'cloudinary',
        primaryFailover: [],
        secondaries: [],
        strict: true,
      });

      const seaweedTopo = resolveTopology(
        createMockConfig({ storageDriver: 'seaweedfs' }),
      );
      expect(seaweedTopo).toEqual({
        mode: 'single',
        primary: 'seaweedfs',
        primaryFailover: [],
        secondaries: [],
        strict: true,
      });
    });

    it('resolves hybrid mode with ordered failovers and explicit replicas', () => {
      const topo = resolveTopology(
        createMockConfig({
          storageDriver: 'hybrid',
          hybridPrimary: 'seaweedfs',
          hybridPrimaryFailover: 'local,cloudinary',
          hybridReplicas: 'cloudinary,local',
          hybridStrict: true,
        }),
      );

      expect(topo.mode).toBe('replicated');
      expect(topo.primary).toBe('seaweedfs');
      expect(topo.primaryFailover).toEqual(['local', 'cloudinary']);
      expect(topo.secondaries).toEqual(['cloudinary', 'local']);
      expect(topo.strict).toBe(true);
    });

    it('excludes primary from primaryFailover and deduplicates failovers', () => {
      const topo = resolveTopology(
        createMockConfig({
          storageDriver: 'hybrid',
          hybridPrimary: 'seaweedfs',
          hybridPrimaryFailover: 'seaweedfs,local,local,cloudinary',
        }),
      );

      expect(topo.primary).toBe('seaweedfs');
      expect(topo.primaryFailover).toEqual(['local', 'cloudinary']);
    });

    it('resolves auto secondaries by excluding primary', () => {
      const topo = resolveTopology(
        createMockConfig({
          storageDriver: 'hybrid',
          hybridPrimary: 'seaweedfs',
          hybridPrimaryFailover: 'local',
          hybridReplicas: 'auto',
        }),
      );

      expect(topo.primary).toBe('seaweedfs');
      expect(topo.primaryFailover).toEqual(['local']);
      // auto excludes seaweedfs (primary), leaving local and cloudinary
      expect(topo.secondaries).toEqual(['local', 'cloudinary']);
    });

    it('deduplicates explicit secondaries', () => {
      const topo = resolveTopology(
        createMockConfig({
          storageDriver: 'hybrid',
          hybridPrimary: 'seaweedfs',
          hybridReplicas: 'local,cloudinary,local,cloudinary',
        }),
      );

      expect(topo.secondaries).toEqual(['local', 'cloudinary']);
    });

    it('throws PermanentError on unsupported STORAGE_DRIVER', () => {
      expect(() =>
        resolveTopology(
          createMockConfig({
            storageDriver: 's3-direct' as unknown as 'local',
          }),
        ),
      ).toThrow(PermanentError);
    });
  });

  describe('StorageRegistry Validation Rules', () => {
    it('throws PermanentError when primary driver is not configured', () => {
      const config = createMockConfig({
        storageDriver: 'hybrid',
        hybridPrimary: 'seaweedfs',
        // remove seaweedfs credentials so driver is not configured
        seaweedfsS3Endpoint: '',
        seaweedfsBucket: '',
      });

      const registry = new StorageRegistry(config);
      expect(() => registry.validateConfiguration()).toThrow(PermanentError);
      expect(() => registry.validateConfiguration()).toThrow(
        /Primary storage driver "seaweedfs" required by STORAGE_DRIVER="hybrid" is not configured/,
      );
    });

    it('throws PermanentError in strict mode when primary appears in replicas', () => {
      const config = createMockConfig({
        storageDriver: 'hybrid',
        hybridPrimary: 'seaweedfs',
        hybridReplicas: 'seaweedfs,local',
        hybridStrict: true,
      });

      const registry = new StorageRegistry(config);
      registry.register(new FakeStorageDriver('seaweedfs'));
      registry.register(new FakeStorageDriver('local'));

      expect(() => registry.validateConfiguration()).toThrow(PermanentError);
      expect(() => registry.validateConfiguration()).toThrow(
        /Primary storage driver "seaweedfs" must not appear in HYBRID_REPLICAS/,
      );
    });

    it('removes primary from replicas and logs error in non-strict mode', () => {
      const config = createMockConfig({
        storageDriver: 'hybrid',
        hybridPrimary: 'seaweedfs',
        hybridReplicas: 'seaweedfs,local',
        hybridStrict: false,
      });

      const registry = new StorageRegistry(config);
      registry.register(new FakeStorageDriver('seaweedfs'));
      registry.register(new FakeStorageDriver('local'));

      expect(() => registry.validateConfiguration()).not.toThrow();
      const topo = registry.getTopology();
      expect(topo.secondaries).toEqual(['local']);
    });

    it('throws PermanentError in strict mode when a replica driver is not configured', () => {
      const config = createMockConfig({
        storageDriver: 'hybrid',
        hybridPrimary: 'seaweedfs',
        hybridReplicas: 'cloudinary,local',
        hybridStrict: true,
        cloudinaryCloudName: '',
        cloudinaryApiKey: '',
        cloudinaryApiSecret: '',
      });

      const registry = new StorageRegistry(config);
      registry.register(new FakeStorageDriver('seaweedfs'));
      registry.register(new FakeStorageDriver('local'));
      // cloudinary is unconfigured

      expect(() => registry.validateConfiguration()).toThrow(PermanentError);
      expect(() => registry.validateConfiguration()).toThrow(
        /Replica storage driver "cloudinary" required by HYBRID_REPLICAS under HYBRID_STRICT=true is not configured/,
      );
    });

    it('removes unconfigured replica and continues in non-strict mode', () => {
      const config = createMockConfig({
        storageDriver: 'hybrid',
        hybridPrimary: 'seaweedfs',
        hybridReplicas: 'cloudinary,local',
        hybridStrict: false,
        cloudinaryCloudName: '',
        cloudinaryApiKey: '',
        cloudinaryApiSecret: '',
      });

      const registry = new StorageRegistry(config);
      registry.register(new FakeStorageDriver('seaweedfs'));
      registry.register(new FakeStorageDriver('local'));
      // cloudinary is unconfigured

      expect(() => registry.validateConfiguration()).not.toThrow();
      expect(registry.getTopology().secondaries).toEqual(['local']);
    });

    it('throws PermanentError in strict mode when failover driver is not configured', () => {
      const config = createMockConfig({
        storageDriver: 'hybrid',
        hybridPrimary: 'seaweedfs',
        hybridPrimaryFailover: 'local',
        hybridStrict: true,
        localStoragePath: '',
      });

      const registry = new StorageRegistry(config);
      registry.register(new FakeStorageDriver('seaweedfs'));
      // local is unconfigured

      expect(() => registry.validateConfiguration()).toThrow(PermanentError);
      expect(() => registry.validateConfiguration()).toThrow(
        /Primary failover driver "local" required by HYBRID_PRIMARY_FAILOVER under HYBRID_STRICT=true is not configured/,
      );
    });

    it('logs warning when multi-node deployment uses local as a secondary (F-27)', () => {
      const config = createMockConfig({
        storageDriver: 'hybrid',
        hybridPrimary: 'seaweedfs',
        hybridReplicas: 'local',
        instanceCountHint: 3,
        hybridStrict: false,
      });

      const registry = new StorageRegistry(config);
      registry.register(new FakeStorageDriver('seaweedfs'));
      registry.register(new FakeStorageDriver('local'));

      const internalRegistry = registry as unknown as {
        logger: { warn: (msg: string) => void };
      };
      const warnSpy = vi.spyOn(internalRegistry.logger, 'warn');
      registry.validateConfiguration();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Multi-node deployment detected (INSTANCE_COUNT_HINT=3) with "local" in HYBRID_REPLICAS',
        ),
      );
    });
  });
});
