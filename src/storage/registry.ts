import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AppConfigService } from '../config/config.service.js';
import { NotFoundError, PermanentError } from '../core/errors/app-error.js';
import { CloudinaryStorageDriver } from './drivers/cloudinary.driver.js';
import { LocalStorageDriver } from './drivers/local.driver.js';
import { SeaweedFSStorageDriver } from './drivers/seaweedfs.driver.js';
import { resolveTopology, type StorageTopology } from './topology.js';
import type { DriverHealth, IStorageDriver, ProviderName } from './types.js';

@Injectable()
export class StorageRegistry implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StorageRegistry.name);
  private readonly drivers = new Map<ProviderName, IStorageDriver>();
  private readonly healthCache = new Map<ProviderName, DriverHealth>();
  private healthInterval?: NodeJS.Timeout;
  private topology!: StorageTopology;

  constructor(private readonly config: AppConfigService) {
    this.initializeDrivers();
  }

  onModuleInit(): void {
    this.validateConfiguration();
    // Start health loop with random jitter between 0 and 500ms
    const jitterMs = Math.floor(Math.random() * 500);
    this.startHealthLoop(jitterMs);
  }

  onModuleDestroy(): void {
    this.stopHealthLoop();
  }

  /**
   * Initializes driver instances whose environment configuration is present.
   */
  private initializeDrivers(): void {
    // 1. Local driver
    if (
      this.config.localStoragePath &&
      this.config.localStoragePath.trim().length > 0
    ) {
      try {
        const local = new LocalStorageDriver({
          rootPath: this.config.localStoragePath,
          stagingDir: this.config.stagingDir,
        });
        if (local.isConfigured()) {
          this.drivers.set('local', local);
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to initialize LocalStorageDriver: ${String(err)}`,
        );
      }
    }

    // 2. Cloudinary driver
    if (
      this.config.cloudinaryCloudName &&
      this.config.cloudinaryApiKey &&
      this.config.cloudinaryApiSecret
    ) {
      const cloudinary = new CloudinaryStorageDriver({
        cloudName: this.config.cloudinaryCloudName,
        apiKey: this.config.cloudinaryApiKey,
        apiSecret: this.config.cloudinaryApiSecret,
        rootFolder: this.config.cloudinaryRootFolder,
        maxObjectBytes: this.config.cloudinaryMaxObjectBytes,
      });
      if (cloudinary.isConfigured()) {
        this.drivers.set('cloudinary', cloudinary);
      }
    }

    // 3. SeaweedFS driver
    if (this.config.seaweedfsS3Endpoint && this.config.seaweedfsBucket) {
      const seaweedfs = new SeaweedFSStorageDriver({
        endpoint: this.config.seaweedfsS3Endpoint,
        publicEndpoint: this.config.seaweedfsPublicEndpoint,
        bucket: this.config.seaweedfsBucket,
        accessKeyId: this.config.seaweedfsAccessKey,
        secretAccessKey: this.config.seaweedfsSecretKey,
        region: this.config.seaweedfsRegion,
        autoCreateBucket: this.config.seaweedfsAutoCreateBucket,
      });
      if (seaweedfs.isConfigured()) {
        this.drivers.set('seaweedfs', seaweedfs);
      }
    }

    this.topology = resolveTopology(this.config);
  }

  /**
   * Validates that the active topology has all required drivers properly configured.
   * Throws PermanentError on misconfiguration so startup fails fast with a precise message.
   */
  validateConfiguration(): void {
    this.topology = resolveTopology(this.config);

    // Primary driver is mandatory
    if (!this.drivers.has(this.topology.primary)) {
      throw new PermanentError(
        `Primary storage driver "${this.topology.primary}" required by STORAGE_DRIVER="${this.config.storageDriver}" is not configured. Please supply the required credentials and configuration.`,
      );
    }

    if (this.topology.mode === 'replicated') {
      // 1. Primary must not appear in replicas
      if (this.topology.secondaries.includes(this.topology.primary)) {
        if (this.topology.strict) {
          throw new PermanentError(
            `Primary storage driver "${this.topology.primary}" must not appear in HYBRID_REPLICAS.`,
          );
        } else {
          this.logger.error(
            `Primary storage driver "${this.topology.primary}" cannot be a replica target. Removing it from active secondaries.`,
          );
          this.topology.secondaries = this.topology.secondaries.filter(
            (s) => s !== this.topology.primary,
          );
        }
      }

      // 2. Primary failovers check
      const validFailovers: ProviderName[] = [];
      for (const failover of this.topology.primaryFailover) {
        if (!this.drivers.has(failover)) {
          if (this.topology.strict) {
            throw new PermanentError(
              `Primary failover driver "${failover}" required by HYBRID_PRIMARY_FAILOVER under HYBRID_STRICT=true is not configured.`,
            );
          } else {
            this.logger.error(
              `Primary failover driver "${failover}" is not configured. Removing from available failover list.`,
            );
          }
        } else {
          validFailovers.push(failover);
        }
      }
      this.topology.primaryFailover = validFailovers;

      // 3. Secondaries check
      const validSecondaries: ProviderName[] = [];
      for (const secondary of this.topology.secondaries) {
        if (!this.drivers.has(secondary)) {
          if (this.topology.strict) {
            throw new PermanentError(
              `Replica storage driver "${secondary}" required by HYBRID_REPLICAS under HYBRID_STRICT=true is not configured.`,
            );
          } else {
            this.logger.error(
              `Replica storage driver "${secondary}" is not configured. Removing from active secondaries because HYBRID_STRICT=false.`,
            );
          }
        } else {
          validSecondaries.push(secondary);
        }
      }
      this.topology.secondaries = validSecondaries;

      // 4. Multi-node warning for local replica (F-27)
      const isProd =
        typeof this.config.isProduction === 'function'
          ? this.config.isProduction()
          : false;
      if (
        (this.config.instanceCountHint > 1 || isProd) &&
        this.topology.secondaries.includes('local')
      ) {
        this.logger.warn(
          `Multi-node deployment detected (INSTANCE_COUNT_HINT=${this.config.instanceCountHint}) with "local" in HYBRID_REPLICAS. Replicas written to local disk across multiple nodes will result in split-brain storage unless using a shared cluster volume (F-27).`,
        );
      }
    }
  }

  /**
   * Registers or replaces a storage driver (useful for test doubles such as FakeStorageDriver).
   */
  register(driver: IStorageDriver): void {
    this.drivers.set(driver.name, driver);
  }

  /**
   * Retrieves a driver by provider name. Throws NotFoundError if not registered.
   */
  get(provider: ProviderName): IStorageDriver {
    const driver = this.drivers.get(provider);
    if (!driver) {
      throw new NotFoundError(
        `Storage driver for provider "${provider}" is not registered or configured.`,
      );
    }
    return driver;
  }

  /**
   * Retrieves the primary driver determined by current topology.
   */
  getPrimary(): IStorageDriver {
    return this.get(this.topology.primary);
  }

  /**
   * Checks whether a driver for the specified provider is registered.
   */
  has(provider: ProviderName): boolean {
    return this.drivers.has(provider);
  }

  /**
   * Returns the resolved storage topology.
   */
  getTopology(): StorageTopology {
    return this.topology;
  }

  /**
   * Returns a snapshot of the latest cached health status for all registered drivers.
   */
  health(): Record<ProviderName, DriverHealth> {
    const result: Partial<Record<ProviderName, DriverHealth>> = {};
    for (const [name] of this.drivers.entries()) {
      const cached = this.healthCache.get(name);
      if (cached) {
        result[name] = cached;
      }
    }
    return result as Record<ProviderName, DriverHealth>;
  }

  /**
   * Checks whether a driver is considered healthy according to the latest probe.
   */
  isHealthy(provider: ProviderName): boolean {
    const cached = this.healthCache.get(provider);
    if (cached !== undefined) {
      return cached.ok;
    }
    return this.drivers.has(provider);
  }

  /**
   * Runs an active health probe against all registered drivers and updates the cache.
   */
  async checkHealth(): Promise<Record<ProviderName, DriverHealth>> {
    const entries = Array.from(this.drivers.entries());
    await Promise.all(
      entries.map(async ([name, driver]) => {
        try {
          const res = await driver.healthCheck();
          this.healthCache.set(name, res);
        } catch (err: unknown) {
          this.healthCache.set(name, {
            ok: false,
            latencyMs: -1,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    return this.health();
  }

  /**
   * Starts the periodic background health probe loop.
   */
  startHealthLoop(initialDelayMs = 0): void {
    this.stopHealthLoop();

    const intervalMs = (this.config.driverHealthIntervalSeconds ?? 30) * 1000;

    const runProbe = (): void => {
      void this.checkHealth().catch((err: unknown) => {
        this.logger.warn(`Driver health probe failed: ${String(err)}`);
      });
    };

    if (initialDelayMs > 0) {
      setTimeout(() => {
        runProbe();
        this.healthInterval = setInterval(runProbe, intervalMs);
        this.healthInterval.unref?.();
      }, initialDelayMs);
    } else {
      runProbe();
      this.healthInterval = setInterval(runProbe, intervalMs);
      this.healthInterval.unref?.();
    }
  }

  /**
   * Stops the background health loop.
   */
  stopHealthLoop(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = undefined;
    }
  }
}
