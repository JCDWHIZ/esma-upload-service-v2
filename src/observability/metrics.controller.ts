import {
  Controller,
  Get,
  Headers,
  Req,
  Res,
  HttpStatus,
  Optional,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiHeader } from '@nestjs/swagger';
import { MetricsService } from './metrics.service.js';
import { AppConfigService } from '../config/config.service.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { UnauthenticatedError } from '../core/errors/app-error.js';

@ApiTags('observability')
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metricsService: MetricsService,
    @Optional() private readonly configService?: AppConfigService,
  ) {}

  @Get()
  @Public()
  @ApiOperation({
    summary: 'Expose Prometheus metrics',
    description:
      'Returns application metrics in Prometheus text format. Protected by METRICS_TOKEN if configured.',
  })
  @ApiHeader({
    name: 'authorization',
    required: false,
    description: 'Bearer token matching METRICS_TOKEN when auth is configured',
  })
  @ApiResponse({
    status: 200,
    description: 'Prometheus metrics payload',
  })
  async getMetrics(
    @Headers('authorization') authHeader?: string,
    @Req() req?: Request,
    @Res() res?: Response,
  ): Promise<unknown> {
    const requiredToken = this.configService?.metricsToken;
    if (requiredToken) {
      const token = authHeader?.replace(/^Bearer\s+/i, '').trim();
      if (!token || token !== requiredToken) {
        throw new UnauthenticatedError(
          'Invalid or missing metrics authentication token',
        );
      }
    }

    const metricsText = await this.metricsService.getMetricsText();

    if (res) {
      res.setHeader('Content-Type', this.metricsService.contentType);
      res.status(HttpStatus.OK).send(metricsText);
      return;
    }

    return metricsText;
  }
}
