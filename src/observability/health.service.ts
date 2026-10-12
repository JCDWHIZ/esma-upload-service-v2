import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as net from 'node:net';
import { AppConfigService } from '../config/config.service.js';
import { StorageRegistry } from '../storage/registry.js';
import type { StorageTopology } from '../storage/topology.js';
import type { DriverHealth, ProviderName } from '../storage/types.js';
import { DatabaseService } from '../db/database.service.js';
import {
  MESSAGE_BROKER,
  type IMessageBroker,
} from '../events/broker.interface.js';

export interface HealthCheck {
  status: 'ok' | 'error';
  message?: string;
  driver?: string;
}

export interface ReadinessChecks {
  stagingDir: HealthCheck;
  storageConfig: HealthCheck;
  database?: HealthCheck;
  migrations?: HealthCheck;
  events?: HealthCheck;
  clamav?: HealthCheck;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly storageRegistry: StorageRegistry,
    @Optional()
    private readonly db?: DatabaseService,
    @Optional()
    @Inject(MESSAGE_BROKER)
    private readonly broker?: IMessageBroker,
  ) {}

  live(): { status: string } {
    return { status: 'ok' };
  }

  async ready(): Promise<{ status: 'ok' | 'error'; checks: ReadinessChecks }> {
    const checks = await this.runReadinessChecks();
    const healthy = (
      Object.values(checks) as Array<HealthCheck | undefined>
    ).every((c) => !c || c.status === 'ok');

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
      const [dbCheck, migCheck] = await Promise.all([
        this.checkDatabase(),
        this.checkMigrations(),
      ]);
      checks.database = dbCheck;
      checks.migrations = migCheck;
    }

    if (this.broker && this.config.eventsEnabled) {
      checks.events = await this.checkEvents();
    }

    if (this.config.isProduction()) {
      checks.clamav = await this.checkClamav();
    }

    return checks;
  }

  private async checkMigrations(): Promise<HealthCheck> {
    try {
      if (!this.db) {
        return { status: 'ok' };
      }
      const hasPending = await this.db.hasPendingMigrations();
      if (hasPending) {
        return {
          status: 'error',
          message: 'Pending database migrations detected',
        };
      }
      return { status: 'ok' };
    } catch (err) {
      return {
        status: 'error',
        message: err instanceof Error ? err.message : 'Migration check failed',
      };
    }
  }

  private async checkEvents(): Promise<HealthCheck> {
    try {
      if (!this.broker) {
        return { status: 'ok' };
      }
      const ok = await this.broker.healthCheck();
      return ok
        ? { status: 'ok' }
        : { status: 'error', message: 'Message broker health check failed' };
    } catch (err) {
      return {
        status: 'error',
        message: `Message broker unreachable: ${String(err)}`,
      };
    }
  }

  private async checkClamav(): Promise<HealthCheck> {
    return new Promise<HealthCheck>((resolve) => {
      const socket = net.createConnection({
        host: this.config.clamavHost,
        port: this.config.clamavPort,
      });

      let resolved = false;
      const finish = (check: HealthCheck) => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          resolve(check);
        }
      };

      socket.setTimeout(3000);
      socket.on('timeout', () =>
        finish({ status: 'error', message: 'ClamAV connection timed out' }),
      );
      socket.on('error', (err) =>
        finish({
          status: 'error',
          message: `ClamAV unreachable at ${this.config.clamavHost}:${this.config.clamavPort}: ${err.message}`,
        }),
      );

      socket.on('connect', () => {
        socket.write('zPING\0');
      });

      let response = '';
      socket.on('data', (chunk) => {
        response += chunk.toString('utf-8');
        if (response.includes('PONG')) {
          finish({ status: 'ok' });
        }
      });

      socket.on('end', () => {
        finish(
          response.includes('PONG')
            ? { status: 'ok' }
            : { status: 'error', message: 'Unexpected response from ClamAV' },
        );
      });
    });
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
