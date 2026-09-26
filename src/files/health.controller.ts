import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import { DatabaseService } from '../db/database.service.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly databaseService: DatabaseService) {}

  @Get('live')
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiResponse({ status: 200, description: 'Service is alive' })
  getLive() {
    return { status: 'UP', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe' })
  @ApiResponse({
    status: 200,
    description: 'Service is ready to handle requests',
  })
  @ApiResponse({
    status: 503,
    description: 'Service or dependent subsystem is unavailable',
  })
  async getReady(@Res({ passthrough: true }) res: Response) {
    const isDbOk = await this.databaseService.ping();
    const isReady = isDbOk;

    if (!isReady) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }

    return {
      status: isReady ? 'UP' : 'DOWN',
      checks: {
        database: isDbOk ? 'UP' : 'DOWN',
        storage: 'UP',
      },
      timestamp: new Date().toISOString(),
    };
  }
}
