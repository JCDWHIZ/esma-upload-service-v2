import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator.js';
import type { StorageTopology } from '../storage/topology.js';
import type { DriverHealth, ProviderName } from '../storage/types.js';
import { HealthService, type ReadinessChecks } from './health.service.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

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
    return this.healthService.live();
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
    const result = await this.healthService.ready();
    res.status(
      result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE,
    );
    return result;
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
    return this.healthService.drivers();
  }
}
