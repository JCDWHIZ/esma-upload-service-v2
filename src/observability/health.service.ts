import { Injectable, Logger, Optional } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AppConfigService } from '../config/config.service.js';
import { StorageRegistry } from '../storage/registry.js';
import type { StorageTopology } from '../storage/topology.js';
import type { DriverHealth, ProviderName } from '../storage/types.js';
import { DatabaseService } from '../db/database.service.js';

export interface HealthCheck {
  status: 'ok' | 'error';
  message?: string;
  driver?: string;
}

export interface ReadinessChecks {
  stagingDir: HealthCheck;
  storageConfig: HealthCheck;
  database?: HealthCheck;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly storageRegistry: StorageRegistry,
    @Optional()
    private readonly db?: DatabaseService,
  ) {}

  live(): { status: string } {
    return { status: 'ok' };
  }

  async ready(): Promise<{ status: 'ok' | 'error'; checks: ReadinessChecks }> {
    const checks = await this.runReadinessChecks();
    const healthy =
      checks.stagingDir.status === 'ok' &&
      checks.storageConfig.status === 'ok' &&
      (!checks.database || checks.database.status === 'ok');

    return {
      status: healthy ? 'ok' : 'error',
      checks,
    };
  }

  drivers(): {
    status: string;
    topology: StorageTopology;
    drivers: Record<ProviderName, DriverHealth>;
  } {
    return {
      status: 'ok',
      topology: this.storageRegistry.getTopology(),
      drivers: this.storageRegistry.health(),
    };
  }

  async runReadinessChecks(): Promise<ReadinessChecks> {
    const [stagingDir, storageConfig] = await Promise.all([
      this.checkStagingDir(),
      this.checkStorageDriver(),
    ]);

    const checks: ReadinessChecks = { stagingDir, storageConfig };

    if (this.db) {
      checks.database = await this.checkDatabase();
    }

    return checks;
  }

  private async checkDatabase(): Promise<HealthCheck> {
    try {
      if (this.db) {
        await this.db.ping();
      }
      return { status: 'ok' };
    } catch (err) {
      this.logger.warn(
        `Readiness check failed — DB ping error: ${String(err)}`,
      );
      return {
        status: 'error',
        message: err instanceof Error ? err.message : 'Database ping failed',
      };
    }
  }

  private async checkStagingDir(): Promise<HealthCheck> {
    const probeFile = path.join(
      this.config.stagingDir,
      `.health-probe-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    );
    try {
      await fs.writeFile(probeFile, '');
      await fs.unlink(probeFile);
      return { status: 'ok' };
    } catch (err) {
      this.logger.warn(
        `Readiness check failed — staging dir not writable: ${String(err)}`,
      );
      return {
        status: 'error',
        message: `staging directory '${this.config.stagingDir}' is not writable`,
      };
    }
  }

  private async checkStorageDriver(): Promise<HealthCheck> {
    const topology = this.storageRegistry.getTopology();
    const primary = topology.primary;

    if (!this.storageRegistry.has(primary)) {
      return {
        status: 'error',
        message: `Primary storage driver '${primary}' is not configured`,
        driver: primary,
      };
    }

    let isOk = this.storageRegistry.isHealthy(primary);
    if (!isOk && Object.keys(this.storageRegistry.health()).length === 0) {
      await this.storageRegistry.checkHealth();
      isOk = this.storageRegistry.isHealthy(primary);
    }

    if (!isOk) {
      const detail = this.storageRegistry.health()[primary]?.detail;
      return {
        status: 'error',
        message: detail
          ? `Primary storage driver '${primary}' unhealthy: ${detail}`
          : `Primary storage driver '${primary}' is unhealthy`,
        driver: primary,
      };
    }

    return { status: 'ok', driver: primary };
  }
}
