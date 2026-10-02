import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import {
  Registry,
  collectDefaultMetrics,
  Histogram,
  Counter,
  Gauge,
} from 'prom-client';
import { AppConfigService } from '../config/config.service.js';

@Injectable()
export class MetricsService implements OnModuleInit {
  public readonly registry: Registry;

  // Custom Prometheus Metrics per ARCH §12 & P6-04
  public readonly uploadDurationSeconds: Histogram<string>;
  public readonly uploadBytesTotal: Counter<string>;
  public readonly uploadFailuresTotal: Counter<string>;
  public readonly replicationLagSeconds: Histogram<string>;
  public readonly replicaStatus: Gauge<string>;
  public readonly outboxPending: Gauge<string>;
  public readonly dlqDepth: Gauge<string>;
  public readonly driverHealth: Gauge<string>;
  public readonly httpRequestsTotal: Counter<string>;
  public readonly duplicateHashTotal: Counter<string>;
  public readonly quarantinedFilesTotal: Counter<string>;
  public readonly sha256MismatchesTotal: Counter<string>;

  constructor(@Optional() private readonly configService?: AppConfigService) {
    this.registry = new Registry();

    this.uploadDurationSeconds = new Histogram({
      name: 'gus_upload_duration_seconds',
      help: 'Upload processing duration in seconds',
      labelNames: ['namespace', 'provider'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [this.registry],
    });

    this.uploadBytesTotal = new Counter({
      name: 'gus_upload_bytes_total',
      help: 'Total size of uploaded payload bytes',
      labelNames: ['namespace', 'provider'],
      registers: [this.registry],
    });

    this.uploadFailuresTotal = new Counter({
      name: 'gus_upload_failures_total',
      help: 'Total count of failed upload operations',
      labelNames: ['namespace', 'code'],
      registers: [this.registry],
    });

    this.replicationLagSeconds = new Histogram({
      name: 'gus_replication_lag_seconds',
      help: 'Replication completion lag in seconds',
      labelNames: ['provider'],
      buckets: [1, 5, 15, 30, 60, 120, 300, 600],
      registers: [this.registry],
    });

    this.replicaStatus = new Gauge({
      name: 'gus_replica_status',
      help: 'File replica count by provider and status',
      labelNames: ['provider', 'status'],
      registers: [this.registry],
    });

    this.outboxPending = new Gauge({
      name: 'gus_outbox_pending',
      help: 'Current count of pending outbox event records',
      registers: [this.registry],
    });

    this.dlqDepth = new Gauge({
      name: 'gus_dlq_depth',
      help: 'Current depth of open dead-letter queue records',
      registers: [this.registry],
    });

    this.driverHealth = new Gauge({
      name: 'gus_driver_health',
      help: 'Storage driver health status (1 = healthy, 0 = unhealthy)',
      labelNames: ['provider'],
      registers: [this.registry],
    });

    this.httpRequestsTotal = new Counter({
      name: 'gus_http_requests_total',
      help: 'Total HTTP requests processed by endpoint and status',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    });

    this.duplicateHashTotal = new Counter({
      name: 'gus_duplicate_hash_total',
      help: 'Total duplicate content hashes detected per tenant',
      labelNames: ['tenant_id', 'namespace'],
      registers: [this.registry],
    });

    this.quarantinedFilesTotal = new Counter({
      name: 'gus_quarantined_files_total',
      help: 'Total count of files quarantined due to security scanning',
      labelNames: ['namespace'],
      registers: [this.registry],
    });

    this.sha256MismatchesTotal = new Counter({
      name: 'gus_sha256_mismatches_total',
      help: 'Total count of checksum integrity mismatches detected',
      labelNames: ['provider'],
      registers: [this.registry],
    });
  }

  onModuleInit(): void {
    const enabled = this.configService?.metricsEnabled ?? true;
    if (enabled) {
      collectDefaultMetrics({
        register: this.registry,
        prefix: 'gus_',
      });
    }
  }

  async getMetricsText(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
