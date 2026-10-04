import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Response } from 'express';
import { MetricsController } from '../../src/observability/metrics.controller.js';
import { MetricsService } from '../../src/observability/metrics.service.js';
import type { AppConfigService } from '../../src/config/config.service.js';
import { UnauthenticatedError } from '../../src/core/errors/app-error.js';

describe('MetricsController (P6-04)', () => {
  let controller: MetricsController;
  let metricsService: MetricsService;
  let mockConfig: Partial<AppConfigService>;

  beforeEach(() => {
    mockConfig = {
      metricsEnabled: true,
      metricsToken: undefined,
    };

    metricsService = new MetricsService(mockConfig as AppConfigService);
    metricsService.onModuleInit();
    controller = new MetricsController(metricsService, mockConfig as AppConfigService);
  });

  function createMockResponse(): { res: Partial<Response>; headers: Record<string, string> } {
    const headers: Record<string, string> = {};

    const res: Partial<Response> = {
      setHeader: vi.fn().mockImplementation((key: string, val: string) => {
        headers[key.toLowerCase()] = val;
        return res;
      }),
      status: vi.fn().mockImplementation((_s: number) => res),
      send: vi.fn().mockImplementation((_b: any) => res),
    };

    return { res, headers };
  }

  it('serves Prometheus metrics text with HTTP 200 when no token is required', async () => {
    const { res } = createMockResponse();
    await controller.getMetrics(undefined, undefined, res as Response);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', expect.stringContaining('text/plain'));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('gus_'));
  });

  it('enforces METRICS_TOKEN validation when configured', async () => {
    (mockConfig as Record<string, any>).metricsToken = 'secret-metrics-token-123';
    controller = new MetricsController(metricsService, mockConfig as AppConfigService);

    // Missing token
    await expect(
      controller.getMetrics(undefined, undefined, undefined),
    ).rejects.toThrow(UnauthenticatedError);

    // Invalid token
    await expect(
      controller.getMetrics('Bearer wrong-token', undefined, undefined),
    ).rejects.toThrow(UnauthenticatedError);

    // Valid token
    const { res } = createMockResponse();
    await controller.getMetrics('Bearer secret-metrics-token-123', undefined, res as Response);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
