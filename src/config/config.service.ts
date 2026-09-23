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
        console.error(err.message);
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

  // --- Storage ---
  get storageDriver(): 'local' | 'cloudinary' | 'seaweedfs' | 'hybrid' {
    return this.config.STORAGE_DRIVER;
  }
  get hybridPrimary(): 'local' | 'cloudinary' | 'seaweedfs' {
    return this.config.HYBRID_PRIMARY;
  }
  get hybridPrimaryFailover(): 'local' | 'cloudinary' | 'seaweedfs' {
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
  get kafkaBrokers(): string {
    return this.config.KAFKA_BROKERS;
  }
  get kafkaClientId(): string {
    return this.config.KAFKA_CLIENT_ID;
  }
  get kafkaGroupId(): string {
    return this.config.KAFKA_GROUP_ID;
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
  get workerRoles(): string {
    return this.config.WORKER_ROLES;
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
  get tombstoneRetentionDays(): number {
    return this.config.TOMBSTONE_RETENTION_DAYS;
  }
  get clamavHost(): string {
    return this.config.CLAMAV_HOST;
  }
  get clamavPort(): number {
    return this.config.CLAMAV_PORT;
  }

  // --- Rollout Flags ---
  get legacyEngine(): 'legacy' | 'core' {
    return this.config.LEGACY_ENGINE;
  }
  get legacyDefaultVisibility(): 'public' | 'private' {
    return this.config.LEGACY_DEFAULT_VISIBILITY;
  }
}
