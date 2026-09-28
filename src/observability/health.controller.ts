import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Res,
  Logger,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AppConfigService } from '../config/config.service.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { StorageRegistry } from '../storage/registry.js';
import type { StorageTopology } from '../storage/topology.js';
import type { DriverHealth, ProviderName } from '../storage/types.js';

interface HealthCheck {
  status: 'ok' | 'error';
  message?: string;
  driver?: string;
}

interface ReadinessChecks {
  stagingDir: HealthCheck;
  storageConfig: HealthCheck;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly storageRegistry: StorageRegistry,
  ) {}

  /**
   * Liveness probe — confirms the process is running.
   * Never returns 5xx unless the process itself is broken.
   */
  @Get('live')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiResponse({ status: 200, description: 'Process is running' })
  live(): { status: string } {
    return { status: 'ok' };
  }

  /**
   * Readiness probe — checks the staging directory is writable and
   * the primary storage driver is configured and healthy.
   * Returns 503 when any check fails.
   */
  @Get('ready')
  @Public()
  @ApiOperation({ summary: 'Readiness probe' })
  @ApiResponse({ status: 200, description: 'Service is ready' })
  @ApiResponse({ status: 503, description: 'Service is not ready' })
  async ready(
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: string; checks: ReadinessChecks }> {
    const checks = await this.runReadinessChecks();
    const healthy =
      checks.stagingDir.status === 'ok' && checks.storageConfig.status === 'ok';

    res.status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: healthy ? 'ok' : 'error', checks };
  }

  /**
   * Storage drivers health probe status (ARCH §6.3).
   */
  @Get('drivers')
  @Public()
  @ApiOperation({ summary: 'Storage drivers health status' })
  @ApiResponse({ status: 200, description: 'Driver health status' })
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

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async runReadinessChecks(): Promise<ReadinessChecks> {
    const [stagingDir, storageConfig] = await Promise.all([
      this.checkStagingDir(),
      this.checkStorageDriver(),
    ]);
    return { stagingDir, storageConfig };
  }

  private async checkStagingDir(): Promise<HealthCheck> {
    // Use a write probe instead of fs.access(W_OK) — W_OK is unreliable on
    // Windows and does not truly verify that writes will succeed.
    const probeFile = path.join(
      this.config.stagingDir,
      `.health-probe-${Date.now()}`,
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

    // If health cache is empty, run an initial probe
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
