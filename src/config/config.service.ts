import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import {
  AppConfig,
  ConfigValidationError,
  redactConfig,
  validateConfig,
} from './schema.js';

export const CONFIG_ENV = 'CONFIG_ENV';

@Injectable()
export class AppConfigService {
  private readonly logger = new Logger(AppConfigService.name);
  private readonly config: AppConfig;
  readonly warnings: string[];

  constructor(
    @Optional() @Inject(CONFIG_ENV) customEnv?: Record<string, unknown>,
  ) {
    const env = customEnv ?? process.env;
    try {
      const result = validateConfig(env);
      this.config = result.config;
      this.warnings = result.warnings;

      // Log any startup warnings
      for (const warning of this.warnings) {
        this.logger.warn(warning);
      }
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        process.stderr.write(`${err.message}\n`);
        if (env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'test') {
          process.exit(1);
        }
      }
      throw err;
    }
  }

  get raw(): AppConfig {
    return this.config;
  }

  get(): AppConfig {
    return this.config;
  }

  get jwtKeys(): string | undefined {
    return this.config.JWT_KEYS;
  }

  toSafeObject(): Record<string, unknown> {
    return redactConfig(this.config);
  }

  isProduction(): boolean {
    return this.config.NODE_ENV === 'production';
  }

  isTest(): boolean {
    return this.config.NODE_ENV === 'test';
  }

  isDevelopment(): boolean {
    return this.config.NODE_ENV === 'development';
  }

  // --- Application ---
  get nodeEnv(): 'development' | 'test' | 'production' {
    return this.config.NODE_ENV;
  }
  get port(): number {
    return this.config.PORT;
  }
  get appBaseUrl(): string {
    return this.config.APP_BASE_URL;
  }
  get basePath(): string {
    return this.config.BASE_PATH;
  }
  get logLevel(): string {
    return this.config.LOG_LEVEL;
  }
  get trustProxy(): string {
    return this.config.TRUST_PROXY;
  }
  get corsAllowedOrigins(): string {
    return this.config.CORS_ALLOWED_ORIGINS;
  }
  get swaggerEnabled(): boolean {
    return this.config.SWAGGER_ENABLED;
  }
  get instanceCountHint(): number {
    return this.config.INSTANCE_COUNT_HINT;
  }

  // --- Auth ---
  get jwtSecret(): string {
    return this.config.JWT_SECRET;
  }
  get jwtAlgorithms(): string {
    return this.config.JWT_ALGORITHMS;
  }
  get jwtClockToleranceSeconds(): number {
    return this.config.JWT_CLOCK_TOLERANCE_SECONDS;
  }
  get adminAllowedRoles(): string {
    return this.config.ADMIN_ALLOWED_ROLES;
  }
  get adminAuthMode(): 'off' | 'report' | 'enforce' {
    return this.config.ADMIN_AUTH_MODE;
  }
  get signedUrlSecret(): string {
    return this.config.SIGNED_URL_SECRET;
  }
  get signedUrlMaxTtlSeconds(): number {
    return this.config.SIGNED_URL_MAX_TTL_SECONDS;
  }
  get identityJwksUri(): string {
    return this.config.IDENTITY_JWKS_URI;
  }
  get identityIssuer(): string {
    return this.config.IDENTITY_ISSUER;
  }

  // --- Database and Cache ---
  get databaseUrl(): string {
    return this.config.DATABASE_URL;
  }
  get databasePoolMax(): number {
    return this.config.DATABASE_POOL_MAX;
  }
  get redisUrl(): string {
    return this.config.REDIS_URL;
  }

  // --- Ingestion ---
  get stagingDir(): string {
    return this.config.STAGING_DIR;
  }
  get stagingMaxAgeMinutes(): number {
    return this.config.STAGING_MAX_AGE_MINUTES;
  }
  get defaultMaxFileSizeBytes(): number {
    return this.config.DEFAULT_MAX_FILE_SIZE_BYTES;
  }
  get policiesFile(): string | undefined {
    return this.config.POLICIES_FILE;
  }

  // --- Storage ---
  get storageDriver(): 'local' | 'cloudinary' | 'seaweedfs' | 'hybrid' {
    return this.config.STORAGE_DRIVER;
  }
  get hybridPrimary(): 'local' | 'cloudinary' | 'seaweedfs' {
    return this.config.HYBRID_PRIMARY;
  }
  get hybridPrimaryFailover(): string {
    return this.config.HYBRID_PRIMARY_FAILOVER;
  }
  get hybridReplicas(): string {
    return this.config.HYBRID_REPLICAS;
  }
  get hybridStrict(): boolean {
    return this.config.HYBRID_STRICT;
  }
  get driverHealthIntervalSeconds(): number {
    return this.config.DRIVER_HEALTH_INTERVAL_SECONDS;
  }

  // --- Local Driver ---
  get localStoragePath(): string {
    return this.config.LOCAL_STORAGE_PATH;
  }

  // --- SeaweedFS ---
  get seaweedfsS3Endpoint(): string {
    return this.config.SEAWEEDFS_S3_ENDPOINT;
  }
  get seaweedfsPublicEndpoint(): string {
    return this.config.SEAWEEDFS_PUBLIC_ENDPOINT;
  }
  get seaweedfsBucket(): string {
    return this.config.SEAWEEDFS_BUCKET;
  }
  get seaweedfsAccessKey(): string {
    return this.config.SEAWEEDFS_ACCESS_KEY;
  }
  get seaweedfsSecretKey(): string {
    return this.config.SEAWEEDFS_SECRET_KEY;
  }
  get seaweedfsRegion(): string {
    return this.config.SEAWEEDFS_REGION;
  }
  get seaweedfsAutoCreateBucket(): boolean {
    return this.config.SEAWEEDFS_AUTO_CREATE_BUCKET;
  }

  // --- Cloudinary ---
  get cloudinaryCloudName(): string {
    return this.config.CLOUDINARY_CLOUD_NAME;
  }
  get cloudinaryApiKey(): string {
    return this.config.CLOUDINARY_API_KEY;
  }
  get cloudinaryApiSecret(): string {
    return this.config.CLOUDINARY_API_SECRET;
  }
  get cloudinaryRootFolder(): string {
    return this.config.CLOUDINARY_ROOT_FOLDER;
  }
  get cloudinaryMaxObjectBytes(): number {
    return this.config.CLOUDINARY_MAX_OBJECT_BYTES;
  }

  // --- Event Pipeline ---
  get eventBroker(): 'memory' | 'kafka' | 'pulsar' {
    return this.config.EVENT_BROKER;
  }
  get allowMemoryBroker(): boolean {
    return this.config.ALLOW_MEMORY_BROKER;
  }
  get eventsEnabled(): boolean {
    return this.config.EVENTS_ENABLED;
  }
  get kafkaBrokers(): string {
    return this.config.KAFKA_BROKERS;
  }
  get kafkaClientId(): string {
    return this.config.KAFKA_CLIENT_ID;
  }
  get kafkaGroupId(): string {
    return this.config.KAFKA_GROUP_ID;
  }
  get kafkaTopicPrefix(): string {
    return this.config.KAFKA_TOPIC_PREFIX;
  }
  get kafkaTopicPartitions(): number {
    return this.config.KAFKA_TOPIC_PARTITIONS;
  }
  get kafkaTopicReplicationFactor(): number {
    return this.config.KAFKA_TOPIC_REPLICATION_FACTOR;
  }
  get kafkaSsl(): boolean {
    return this.config.KAFKA_SSL;
  }
  get kafkaSaslMechanism():
    'plain' | 'scram-sha-256' | 'scram-sha-512' | undefined {
    return this.config.KAFKA_SASL_MECHANISM;
  }
  get kafkaSaslUsername(): string {
    return this.config.KAFKA_SASL_USERNAME;
  }
  get kafkaSaslPassword(): string {
    return this.config.KAFKA_SASL_PASSWORD;
  }
  get pulsarServiceUrl(): string {
    return this.config.PULSAR_SERVICE_URL;
  }
  get pulsarAuthToken(): string {
    return this.config.PULSAR_AUTH_TOKEN;
  }
  get pulsarTenant(): string {
    return this.config.PULSAR_TENANT;
  }
  get pulsarNamespace(): string {
    return this.config.PULSAR_NAMESPACE;
  }

  // --- Workers ---
  get embeddedWorker(): boolean {
    return this.config.EMBEDDED_WORKER;
  }
  get workerRoles(): string {
    return this.config.WORKER_ROLES;
  }
  get workerHealthPort(): number {
    return this.config.WORKER_HEALTH_PORT;
  }
  get replicationMaxAttempts(): number {
    return this.config.REPLICATION_MAX_ATTEMPTS;
  }
  get replicationConcurrency(): number {
    return this.config.REPLICATION_CONCURRENCY;
  }
  get outboxRetentionHours(): number {
    return this.config.OUTBOX_RETENTION_HOURS;
  }
  get outboxPollMinMs(): number {
    return this.config.OUTBOX_POLL_MIN_MS;
  }
  get outboxPollMaxMs(): number {
    return this.config.OUTBOX_POLL_MAX_MS;
  }
  get outboxBatchSize(): number {
    return this.config.OUTBOX_BATCH_SIZE;
  }
  get outboxListenNotify(): boolean {
    return this.config.OUTBOX_LISTEN_NOTIFY;
  }
  get consumerHandlerTimeoutMs(): number {
    return this.config.CONSUMER_HANDLER_TIMEOUT_MS;
  }
  get consumerShutdownTimeoutMs(): number {
    return this.config.CONSUMER_SHUTDOWN_TIMEOUT_MS;
  }
  get tombstoneRetentionDays(): number {
    return this.config.TOMBSTONE_RETENTION_DAYS;
  }
  get clamavHost(): string {
    return this.config.CLAMAV_HOST;
  }
  get clamavPort(): number {
    return this.config.CLAMAV_PORT;
  }
  get clamavTimeoutMs(): number {
    return this.config.CLAMAV_TIMEOUT_MS;
  }
  get scanFailMode(): 'closed' | 'open' {
    return this.config.SCAN_FAIL_MODE;
  }
  get quarantineRetentionDays(): number {
    return this.config.QUARANTINE_RETENTION_DAYS;
  }
  get purgeInline(): boolean {
    return this.config.PURGE_INLINE;
  }
  get sweepIntervalSeconds(): number {
    return this.config.SWEEP_INTERVAL_SECONDS;
  }
  get sweepQueuedAfterMinutes(): number {
    return this.config.SWEEP_QUEUED_AFTER_MINUTES;
  }
  get sweepLeaseTimeoutMinutes(): number {
    return this.config.SWEEP_LEASE_TIMEOUT_MINUTES;
  }
  get sweepDeletingAfterMinutes(): number {
    return this.config.SWEEP_DELETING_AFTER_MINUTES;
  }
  get redriveAfterHours(): number {
    return this.config.REDRIVE_AFTER_HOURS;
  }
  get redriveMaxTimes(): number {
    return this.config.REDRIVE_MAX_TIMES;
  }
  get derivativeMaxInputPixels(): number {
    return this.config.DERIVATIVE_MAX_INPUT_PIXELS;
  }
  get derivativeConcurrency(): number {
    return this.config.DERIVATIVE_CONCURRENCY;
  }
  get dedupMode(): 'off' | 'reference' {
    return this.config.DEDUP_MODE;
  }
  get idempotencyKeyTtlHours(): number {
    return this.config.IDEMPOTENCY_KEY_TTL_HOURS;
  }

  // --- Observability & Metrics (P6-04) ---
  get metricsEnabled(): boolean {
    return this.config.METRICS_ENABLED;
  }
  get metricsPort(): number {
    return this.config.METRICS_PORT;
  }
  get metricsToken(): string | undefined {
    return this.config.METRICS_TOKEN;
  }
  get otelExporterOtlpEndpoint(): string {
    return this.config.OTEL_EXPORTER_OTLP_ENDPOINT;
  }
  get otelServiceName(): string {
    return this.config.OTEL_SERVICE_NAME;
  }

  // --- Audit Logging ---
  get auditReads(): 'all' | 'sampled' | 'off' {
    return this.config.AUDIT_READS;
  }
  get auditSampleRate(): number {
    return this.config.AUDIT_SAMPLE_RATE;
  }
  get auditStream(): boolean {
    return this.config.AUDIT_STREAM;
  }

  // --- Rate Limiting & Quotas (P6-02) ---
  get rateLimitEnabled(): boolean {
    return this.config.RATE_LIMIT_ENABLED;
  }
  get rateLimitFailOpenReads(): boolean {
    return this.config.RATE_LIMIT_FAIL_OPEN_READS;
  }
  get rateLimitFailClosedMutations(): boolean {
    return this.config.RATE_LIMIT_FAIL_CLOSED_MUTATIONS;
  }
  get defaultUploadLimitPerMin(): number {
    return this.config.DEFAULT_UPLOAD_LIMIT_PER_MIN;
  }
  get defaultUploadBytesPerMin(): number {
    return this.config.DEFAULT_UPLOAD_BYTES_PER_MIN;
  }
  get defaultReadLimitPerMin(): number {
    return this.config.DEFAULT_READ_LIMIT_PER_MIN;
  }
  get defaultFailedAuthLimitPerMin(): number {
    return this.config.DEFAULT_FAILED_AUTH_LIMIT_PER_MIN;
  }
}
