import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../../src/config/config.service.js';
import {
  NotFoundError,
  PermanentError,
} from '../../src/core/errors/app-error.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { resolveTopology } from '../../src/storage/topology.js';
import type { DriverHealth, IStorageDriver } from '../../src/storage/types.js';
import { FakeStorageDriver } from '../helpers/storage-driver.mock.js';

describe('StorageRegistry & Topology Unit Tests', () => {
  const createMockConfig = (
    overrides?: Partial<AppConfigService>,
  ): AppConfigService =>
    ({
      storageDriver: 'local',
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
      driverHealthIntervalSeconds: 10,
      ...overrides,
    }) as unknown as AppConfigService;

  describe('resolveTopology', () => {
    it('resolves single mode for local, cloudinary, and seaweedfs', () => {
      const localTopo = resolveTopology(
        createMockConfig({ storageDriver: 'local' }),
      );
      expect(localTopo.mode).toBe('single');
      expect(localTopo.primary).toBe('local');
      expect(localTopo.secondaries).toEqual([]);

      const cloudTopo = resolveTopology(
        createMockConfig({ storageDriver: 'cloudinary' }),
      );
      expect(cloudTopo.mode).toBe('single');
      expect(cloudTopo.primary).toBe('cloudinary');

      const seaweedTopo = resolveTopology(
        createMockConfig({ storageDriver: 'seaweedfs' }),
      );
      expect(seaweedTopo.mode).toBe('single');
      expect(seaweedTopo.primary).toBe('seaweedfs');
    });

    it('resolves replicated mode for hybrid with explicit secondaries', () => {
      const topo = resolveTopology(
        createMockConfig({
          storageDriver: 'hybrid',
          hybridPrimary: 'seaweedfs',
          hybridPrimaryFailover: 'local',
          hybridReplicas: 'cloudinary,local',
          hybridStrict: true,
        }),
      );
      expect(topo.mode).toBe('replicated');
      expect(topo.primary).toBe('seaweedfs');
      expect(topo.primaryFailover).toEqual(['local']);
      expect(topo.secondaries).toEqual(['cloudinary', 'local']);
      expect(topo.strict).toBe(true);
    });

    it('resolves auto secondaries excluding primary', () => {
      const topo = resolveTopology(
        createMockConfig({
          storageDriver: 'hybrid',
          hybridPrimary: 'seaweedfs',
          hybridReplicas: 'auto',
        }),
      );
      expect(topo.mode).toBe('replicated');
      expect(topo.secondaries).toEqual(['local', 'cloudinary']);
    });
  });

  describe('StorageRegistry Startup & Validation', () => {
    it('initializes configured drivers and passes validation when primary is configured', () => {
      const config = createMockConfig({ storageDriver: 'local' });
      const registry = new StorageRegistry(config);

      expect(() => registry.validateConfiguration()).not.toThrow();
      expect(registry.has('local')).toBe(true);
      expect(registry.getPrimary().name).toBe('local');
    });

    it('fails fast with PermanentError when primary driver is unconfigured', () => {
      const config = createMockConfig({
        storageDriver: 'seaweedfs',
        seaweedfsS3Endpoint: '',
        seaweedfsBucket: '',
      });
      const registry = new StorageRegistry(config);

      expect(() => registry.validateConfiguration()).toThrow(PermanentError);
      expect(() => registry.validateConfiguration()).toThrow(
        /Primary storage driver "seaweedfs" required by STORAGE_DRIVER="seaweedfs" is not configured/,
      );
    });

    it('fails fast with PermanentError when strict hybrid replication lacks a replica', () => {
      const config = createMockConfig({
        storageDriver: 'hybrid',
        hybridPrimary: 'local',
        hybridReplicas: 'cloudinary',
        hybridStrict: true,
        cloudinaryCloudName: '', // Unconfigured
      });
      const registry = new StorageRegistry(config);

      expect(() => registry.validateConfiguration()).toThrow(PermanentError);
      expect(() => registry.validateConfiguration()).toThrow(
        /Replica storage driver "cloudinary" required by HYBRID_REPLICAS under HYBRID_STRICT=true is not configured/,
      );
    });

    it('allows unconfigured replicas when strict is false', () => {
      const config = createMockConfig({
        storageDriver: 'hybrid',
        hybridPrimary: 'local',
        hybridReplicas: 'cloudinary',
        hybridStrict: false,
        cloudinaryCloudName: '',
      });
      const registry = new StorageRegistry(config);
      expect(() => registry.validateConfiguration()).not.toThrow();
    });

    it('throws NotFoundError when requesting an unregistered driver', () => {
      const config = createMockConfig({
        storageDriver: 'local',
        cloudinaryCloudName: '',
      });
      const registry = new StorageRegistry(config);
      expect(() => registry.get('cloudinary')).toThrow(NotFoundError);
    });

    it('allows registering custom drivers like FakeStorageDriver', () => {
      const config = createMockConfig({ storageDriver: 'local' });
      const registry = new StorageRegistry(config);
      const fake = new FakeStorageDriver('cloudinary');

      registry.register(fake);
      expect(registry.has('cloudinary')).toBe(true);
      expect(registry.get('cloudinary')).toBe(fake);
    });
  });

  describe('Health Probes & Flapping with Fake Timers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('runs health probes and tracks driver flapping', async () => {
      const config = createMockConfig({
        storageDriver: 'local',
        driverHealthIntervalSeconds: 5,
        seaweedfsS3Endpoint: undefined,
        seaweedfsBucket: undefined,
        cloudinaryCloudName: undefined,
      });
      const registry = new StorageRegistry(config);

      let isDriverHealthy = true;
      const mockDriver: IStorageDriver = {
        name: 'local',
        capabilities: {
          rangeReads: true,
          presignedUrls: false,
          publicCdn: false,
          imageTransforms: false,
          privateDelivery: false,
        },
        isConfigured: () => true,
        healthCheck: (): Promise<DriverHealth> =>
          Promise.resolve({
            ok: isDriverHealthy,
            latencyMs: 10,
            detail: isDriverHealthy ? undefined : 'Disk IO error',
          }),
        upload: () => Promise.reject(new Error('not implemented')),
        downloadStream: () => Promise.reject(new Error('not implemented')),
        stat: () => Promise.resolve(null),
        getDirectUrl: () => Promise.resolve(null),
        delete: () => Promise.resolve(),
      };

      registry.register(mockDriver);

      // Initial probe: healthy
      await registry.checkHealth();
      expect(registry.isHealthy('local')).toBe(true);
      expect(registry.health()['local']?.ok).toBe(true);

      // Simulate driver failure (flapping to unhealthy)
      isDriverHealthy = false;
      await registry.checkHealth();
      expect(registry.isHealthy('local')).toBe(false);
      expect(registry.health()['local']?.ok).toBe(false);
      expect(registry.health()['local']?.detail).toBe('Disk IO error');

      // Simulate recovery (flapping back to healthy)
      isDriverHealthy = true;
      await registry.checkHealth();
      expect(registry.isHealthy('local')).toBe(true);
      expect(registry.health()['local']?.ok).toBe(true);
    });

    it('executes periodic health checks in background loop', async () => {
      const config = createMockConfig({
        storageDriver: 'local',
        driverHealthIntervalSeconds: 5,
        seaweedfsS3Endpoint: undefined,
        seaweedfsBucket: undefined,
        cloudinaryCloudName: undefined,
      });
      const registry = new StorageRegistry(config);

      let probeCount = 0;
      const mockDriver: IStorageDriver = {
        name: 'local',
        capabilities: {
          rangeReads: true,
          presignedUrls: false,
          publicCdn: false,
          imageTransforms: false,
          privateDelivery: false,
        },
        isConfigured: () => true,
        healthCheck: (): Promise<DriverHealth> => {
          probeCount++;
          return Promise.resolve({ ok: true, latencyMs: 5 });
        },
        upload: () => Promise.reject(new Error('not implemented')),
        downloadStream: () => Promise.reject(new Error('not implemented')),
        stat: () => Promise.resolve(null),
        getDirectUrl: () => Promise.resolve(null),
        delete: () => Promise.resolve(),
      };

      registry.register(mockDriver);
      registry.startHealthLoop(0);

      // Probe 1 runs immediately
      expect(probeCount).toBe(1);

      // Advance by 5 seconds
      await vi.advanceTimersByTimeAsync(5000);
      expect(probeCount).toBe(2);

      // Advance by another 5 seconds
      await vi.advanceTimersByTimeAsync(5000);
      expect(probeCount).toBe(3);

      registry.stopHealthLoop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(probeCount).toBe(3); // Stopped, does not increment
    });
  });
});
