import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsService } from '../../src/observability/metrics.service.js';
import type { AppConfigService } from '../../src/config/config.service.js';

describe('MetricsService (P6-04)', () => {
  let metricsService: MetricsService;
  let mockConfig: Partial<AppConfigService>;

  beforeEach(() => {
    mockConfig = {
      metricsEnabled: true,
    };
    metricsService = new MetricsService(mockConfig as AppConfigService);
    metricsService.onModuleInit();
  });

  it('registers all required custom GUS metrics per ARCH §12', async () => {
    metricsService.uploadDurationSeconds.observe({ namespace: 'generic', provider: 'local' }, 0.15);
    metricsService.uploadBytesTotal.inc({ namespace: 'generic', provider: 'local' }, 1024);
    metricsService.uploadFailuresTotal.inc({ namespace: 'generic', code: 'QUOTA_EXCEEDED' });
    metricsService.driverHealth.set({ provider: 'local' }, 1);
    metricsService.driverHealth.set({ provider: 'seaweedfs' }, 0);
    metricsService.outboxPending.set(12);
    metricsService.dlqDepth.set(0);

    const metricsText = await metricsService.getMetricsText();

    expect(metricsText).toContain('gus_upload_duration_seconds');
    expect(metricsText).toContain('gus_upload_bytes_total');
    expect(metricsText).toContain('gus_upload_failures_total');
    expect(metricsText).toContain('gus_driver_health');
    expect(metricsText).toContain('gus_outbox_pending');
    expect(metricsText).toContain('gus_dlq_depth');
    expect(metricsText).toContain('gus_http_requests_total');
  });

  it('provides correct content-type header for Prometheus scraping', () => {
    expect(metricsService.contentType).toContain('text/plain');
  });
});
