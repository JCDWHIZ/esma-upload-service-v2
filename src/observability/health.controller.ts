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

  constructor(private readonly config: AppConfigService) {}

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
   * the configured storage driver has the minimum required config.
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

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async runReadinessChecks(): Promise<ReadinessChecks> {
    const [stagingDir, storageConfig] = await Promise.all([
      this.checkStagingDir(),
      Promise.resolve(this.checkStorageConfig()),
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

  private checkStorageConfig(): HealthCheck {
    const driver = this.config.storageDriver;
    let configured: boolean;

    switch (driver) {
      case 'local':
        configured = Boolean(this.config.localStoragePath);
        break;
      case 'cloudinary':
        configured =
          Boolean(this.config.cloudinaryCloudName) &&
          Boolean(this.config.cloudinaryApiKey) &&
          Boolean(this.config.cloudinaryApiSecret);
        break;
      case 'seaweedfs':
      case 'hybrid':
        configured = Boolean(this.config.seaweedfsS3Endpoint);
        break;
      default:
        configured = false;
    }

    if (!configured) {
      return {
        status: 'error',
        message: `storage driver '${driver}' configuration is incomplete`,
        driver,
      };
    }

    return { status: 'ok', driver };
  }
}
