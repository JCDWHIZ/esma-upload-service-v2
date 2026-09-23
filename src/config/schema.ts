import { z } from 'zod';
import * as path from 'node:path';

export const SECRET_KEYS = new Set<string>([
  'JWT_SECRET',
  'SIGNED_URL_SECRET',
  'DATABASE_URL',
  'REDIS_URL',
  'SEAWEEDFS_ACCESS_KEY',
  'SEAWEEDFS_SECRET_KEY',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'PULSAR_AUTH_TOKEN',
]);

const booleanCoerce = z.preprocess((val) => {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
  }
  return val;
}, z.boolean());

const intCoerce = (defaultValue?: number) =>
  z.preprocess((val) => {
    if (typeof val === 'number') return val;
    if (typeof val === 'string' && val.trim() !== '') {
      const parsed = parseInt(val.trim(), 10);
      return isNaN(parsed) ? val : parsed;
    }
    return defaultValue;
  }, z.number().int());

export const rawConfigSchema = z.object({
  // --- Application ---
  NODE_ENV: z
    .preprocess(
      (val) => (typeof val === 'string' ? val.trim().toLowerCase() : val),
      z.enum(['development', 'test', 'production']),
    )
    .default('development'),
  PORT: intCoerce(7030).pipe(z.number().min(1).max(65535)).default(7030),
  APP_BASE_URL: z.string().default('http://localhost:7030'),
  LOG_LEVEL: z
    .preprocess(
      (val) => (typeof val === 'string' ? val.trim().toLowerCase() : val),
      z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
    )
    .default('info'),
  TRUST_PROXY: z.string().default('loopback'),
  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
  SWAGGER_ENABLED: booleanCoerce.default(true),
  INSTANCE_COUNT_HINT: intCoerce(1).default(1),

  // --- Auth ---
  JWT_SECRET: z
    .string()
    .default('dev-insecure-jwt-secret-do-not-use-in-production-min-32-chars'),
  JWT_ALGORITHMS: z.string().default('HS256'),
  JWT_CLOCK_TOLERANCE_SECONDS: intCoerce(5).default(5),
  ADMIN_ALLOWED_ROLES: z.string().default('superadmin'),
  ADMIN_AUTH_MODE: z.enum(['off', 'report', 'enforce']).default('enforce'),
  SIGNED_URL_SECRET: z
    .string()
    .default('dev-insecure-signed-url-secret-do-not-use-in-prod'),
  SIGNED_URL_MAX_TTL_SECONDS: intCoerce(900).default(900),
  IDENTITY_JWKS_URI: z
    .string()
    .default('https://api.esma.elsoft.ng/identity/oauth2/jwks'),
  IDENTITY_ISSUER: z
    .string()
    .default('http://esma-identity-service:7071/identity'),

  // --- Database and cache ---
  DATABASE_URL: z.string().default('postgres://gus:gus@localhost:5432/gus'),
  DATABASE_POOL_MAX: intCoerce(10).default(10),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // --- Ingestion ---
  STAGING_DIR: z.string().default('/tmp/gus-staging'),
  STAGING_MAX_AGE_MINUTES: intCoerce(60).default(60),
  DEFAULT_MAX_FILE_SIZE_BYTES: intCoerce(20971520).default(20971520),

  // --- Storage selection: local | cloudinary | seaweedfs | hybrid ---
  STORAGE_DRIVER: z
    .enum(['local', 'cloudinary', 'seaweedfs', 'hybrid'])
    .default('local'),
  HYBRID_PRIMARY: z
    .enum(['local', 'cloudinary', 'seaweedfs'])
    .default('seaweedfs'),
  HYBRID_PRIMARY_FAILOVER: z
    .enum(['local', 'cloudinary', 'seaweedfs'])
    .default('local'),
  HYBRID_REPLICAS: z.string().default('cloudinary,local'),
  HYBRID_STRICT: booleanCoerce.default(true),
  DRIVER_HEALTH_INTERVAL_SECONDS: intCoerce(30).default(30),

  // --- Local driver (dev / single node only) ---
  LOCAL_STORAGE_PATH: z.string().default('/data/storage'),

  // --- SeaweedFS S3 gateway ---
  SEAWEEDFS_S3_ENDPOINT: z.string().default('http://localhost:8333'),
  SEAWEEDFS_PUBLIC_ENDPOINT: z.string().default(''),
  SEAWEEDFS_BUCKET: z.string().default('esma-uploads'),
  SEAWEEDFS_ACCESS_KEY: z.string().default(''),
  SEAWEEDFS_SECRET_KEY: z.string().default(''),
  SEAWEEDFS_REGION: z.string().default('us-east-1'),
  SEAWEEDFS_AUTO_CREATE_BUCKET: booleanCoerce.default(false),

  // --- Cloudinary ---
  CLOUDINARY_CLOUD_NAME: z.string().default(''),
  CLOUDINARY_API_KEY: z.string().default(''),
  CLOUDINARY_API_SECRET: z.string().default(''),
  CLOUDINARY_ROOT_FOLDER: z.string().default('uploads'),
  CLOUDINARY_MAX_OBJECT_BYTES: intCoerce(10485760).default(10485760),

  // --- Event pipeline: memory | kafka | pulsar ---
  EVENT_BROKER: z.enum(['memory', 'kafka', 'pulsar']).default('memory'),
  ALLOW_MEMORY_BROKER: booleanCoerce.default(false),
  KAFKA_BROKERS: z.string().default('localhost:9092'),
  KAFKA_CLIENT_ID: z.string().default('esma-upload-service'),
  KAFKA_GROUP_ID: z.string().default('esma-upload-workers'),
  PULSAR_SERVICE_URL: z.string().default('pulsar://localhost:6650'),
  PULSAR_AUTH_TOKEN: z.string().default(''),
  PULSAR_TENANT: z.string().default('esma'),
  PULSAR_NAMESPACE: z.string().default('uploads'),

  // --- Workers ---
  WORKER_ROLES: z.string().default('relay,replication,processing,sweeper'),
  REPLICATION_MAX_ATTEMPTS: intCoerce(6).default(6),
  REPLICATION_CONCURRENCY: intCoerce(4).default(4),
  OUTBOX_RETENTION_HOURS: intCoerce(72).default(72),
  TOMBSTONE_RETENTION_DAYS: intCoerce(30).default(30),
  CLAMAV_HOST: z.string().default(''),
  CLAMAV_PORT: intCoerce(3310).default(3310),

  // --- Rollout flags (removed in P6-10) ---
  LEGACY_ENGINE: z.enum(['legacy', 'core']).default('legacy'),
  LEGACY_DEFAULT_VISIBILITY: z.enum(['public', 'private']).default('public'),
});

export type RawConfig = z.infer<typeof rawConfigSchema>;

export interface ConfigValidationResult {
  config: RawConfig;
  warnings: string[];
}

export class ConfigValidationError extends Error {
  constructor(
    public readonly issues: Array<{ field: string; message: string }>,
  ) {
    const formatted = issues
      .map((i) => `  - ${i.field}: ${i.message}`)
      .join('\n');
    super(
      `\n================================================================================\n` +
        `CONFIGURATION ERROR: The application failed to start due to invalid configuration:\n` +
        `${formatted}\n` +
        `================================================================================\n`,
    );
    this.name = 'ConfigValidationError';
  }
}

function checkPathOverlap(pathA: string, pathB: string): boolean {
  const normA = path.resolve(path.normalize(pathA));
  const normB = path.resolve(path.normalize(pathB));

  if (normA === normB) return true;

  const relAtoB = path.relative(normA, normB);
  if (!relAtoB.startsWith('..') && !path.isAbsolute(relAtoB)) return true;

  const relBtoA = path.relative(normB, normA);
  if (!relBtoA.startsWith('..') && !path.isAbsolute(relBtoA)) return true;

  return false;
}

function usesStorageDriver(
  driver: 'local' | 'cloudinary' | 'seaweedfs',
  data: RawConfig,
): boolean {
  if (data.STORAGE_DRIVER === driver) return true;
  if (data.STORAGE_DRIVER === 'hybrid') {
    if (data.HYBRID_PRIMARY === driver) return true;
    if (data.HYBRID_PRIMARY_FAILOVER === driver) return true;
    const replicas = data.HYBRID_REPLICAS.split(',').map((r) => r.trim());
    if (replicas.includes(driver)) return true;
  }
  return false;
}

export function runCrossFieldGuards(
  data: Record<string, any>,
  addIssue: (field: string, message: string) => void,
): void {
  const isProd = data.NODE_ENV === 'production';

  // Path safety: LOCAL_STORAGE_PATH must not be inside STAGING_DIR or vice versa
  if (
    typeof data.LOCAL_STORAGE_PATH === 'string' &&
    typeof data.STAGING_DIR === 'string' &&
    checkPathOverlap(data.LOCAL_STORAGE_PATH, data.STAGING_DIR)
  ) {
    addIssue(
      'LOCAL_STORAGE_PATH',
      `LOCAL_STORAGE_PATH ('${data.LOCAL_STORAGE_PATH}') and STAGING_DIR ('${data.STAGING_DIR}') must not be the same directory or contain one another.`,
    );
  }

  // Storage drivers required variables
  if (usesStorageDriver('cloudinary', data as RawConfig)) {
    if (
      !data.CLOUDINARY_CLOUD_NAME ||
      String(data.CLOUDINARY_CLOUD_NAME).trim() === ''
    ) {
      addIssue(
        'CLOUDINARY_CLOUD_NAME',
        'CLOUDINARY_CLOUD_NAME is required when Cloudinary driver is enabled',
      );
    }
    if (
      !data.CLOUDINARY_API_KEY ||
      String(data.CLOUDINARY_API_KEY).trim() === ''
    ) {
      addIssue(
        'CLOUDINARY_API_KEY',
        'CLOUDINARY_API_KEY is required when Cloudinary driver is enabled',
      );
    }
    if (
      !data.CLOUDINARY_API_SECRET ||
      String(data.CLOUDINARY_API_SECRET).trim() === ''
    ) {
      addIssue(
        'CLOUDINARY_API_SECRET',
        'CLOUDINARY_API_SECRET is required when Cloudinary driver is enabled',
      );
    }
  }

  if (usesStorageDriver('seaweedfs', data as RawConfig)) {
    if (
      !data.SEAWEEDFS_S3_ENDPOINT ||
      String(data.SEAWEEDFS_S3_ENDPOINT).trim() === ''
    ) {
      addIssue(
        'SEAWEEDFS_S3_ENDPOINT',
        'SEAWEEDFS_S3_ENDPOINT is required when SeaweedFS driver is enabled',
      );
    }
    if (!data.SEAWEEDFS_BUCKET || String(data.SEAWEEDFS_BUCKET).trim() === '') {
      addIssue(
        'SEAWEEDFS_BUCKET',
        'SEAWEEDFS_BUCKET is required when SeaweedFS driver is enabled',
      );
    }
    if (isProd) {
      if (
        !data.SEAWEEDFS_ACCESS_KEY ||
        String(data.SEAWEEDFS_ACCESS_KEY).trim() === ''
      ) {
        addIssue(
          'SEAWEEDFS_ACCESS_KEY',
          'SEAWEEDFS_ACCESS_KEY is required in production when SeaweedFS driver is enabled',
        );
      }
      if (
        !data.SEAWEEDFS_SECRET_KEY ||
        String(data.SEAWEEDFS_SECRET_KEY).trim() === ''
      ) {
        addIssue(
          'SEAWEEDFS_SECRET_KEY',
          'SEAWEEDFS_SECRET_KEY is required in production when SeaweedFS driver is enabled',
        );
      }
    }
  }

  if (usesStorageDriver('local', data as RawConfig)) {
    if (
      !data.LOCAL_STORAGE_PATH ||
      String(data.LOCAL_STORAGE_PATH).trim() === ''
    ) {
      addIssue(
        'LOCAL_STORAGE_PATH',
        'LOCAL_STORAGE_PATH is required when local driver is enabled',
      );
    }
  }

  // Event broker rules
  if (data.EVENT_BROKER === 'kafka') {
    if (!data.KAFKA_BROKERS || String(data.KAFKA_BROKERS).trim() === '') {
      addIssue(
        'KAFKA_BROKERS',
        'KAFKA_BROKERS is required when EVENT_BROKER=kafka',
      );
    }
  }

  if (data.EVENT_BROKER === 'pulsar') {
    if (
      !data.PULSAR_SERVICE_URL ||
      String(data.PULSAR_SERVICE_URL).trim() === ''
    ) {
      addIssue(
        'PULSAR_SERVICE_URL',
        'PULSAR_SERVICE_URL is required when EVENT_BROKER=pulsar',
      );
    }
  }

  const isMemoryBrokerAllowed =
    data.ALLOW_MEMORY_BROKER === true ||
    data.ALLOW_MEMORY_BROKER === 'true' ||
    data.ALLOW_MEMORY_BROKER === 1;

  if (data.EVENT_BROKER === 'memory' && isProd && !isMemoryBrokerAllowed) {
    addIssue(
      'ALLOW_MEMORY_BROKER',
      'EVENT_BROKER=memory is forbidden in production unless ALLOW_MEMORY_BROKER=true',
    );
  }

  // Production guards
  if (isProd) {
    if (!data.JWT_SECRET || String(data.JWT_SECRET).length < 32) {
      addIssue(
        'JWT_SECRET',
        'JWT_SECRET must be at least 32 characters in production',
      );
    }

    if (!data.SIGNED_URL_SECRET || String(data.SIGNED_URL_SECRET).length < 32) {
      addIssue(
        'SIGNED_URL_SECRET',
        'SIGNED_URL_SECRET must be at least 32 characters in production',
      );
    }

    if (
      data.JWT_SECRET &&
      data.SIGNED_URL_SECRET &&
      data.JWT_SECRET === data.SIGNED_URL_SECRET
    ) {
      addIssue(
        'SIGNED_URL_SECRET',
        'SIGNED_URL_SECRET must differ from JWT_SECRET',
      );
    }

    if (data.ADMIN_AUTH_MODE === 'off') {
      addIssue(
        'ADMIN_AUTH_MODE',
        'ADMIN_AUTH_MODE cannot be "off" in production',
      );
    }
  }
}

export const appConfigSchema = rawConfigSchema.superRefine((data, ctx) => {
  runCrossFieldGuards(data, (field, message) => {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [field],
      message,
    });
  });
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export function validateConfig(
  rawEnv: Record<string, unknown>,
): ConfigValidationResult {
  const issues: Array<{ field: string; message: string }> = [];

  const parseResult = rawConfigSchema.safeParse(rawEnv);
  if (!parseResult.success) {
    for (const issue of parseResult.error.issues) {
      issues.push({
        field: issue.path.join('.'),
        message: issue.message,
      });
    }
  }

  const baseDefaults = rawConfigSchema.parse({});
  const candidateData = Object.assign(
    {},
    baseDefaults,
    rawEnv,
    parseResult.success ? parseResult.data : {},
  );

  runCrossFieldGuards(candidateData, (field, message) => {
    if (!issues.some((i) => i.field === field && i.message === message)) {
      issues.push({ field, message });
    }
  });

  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }

  const config = Object.freeze(parseResult.data!);
  const warnings: string[] = [];

  if (config.NODE_ENV === 'production') {
    if (config.SWAGGER_ENABLED) {
      warnings.push(
        'SWAGGER_ENABLED is true in production; OpenAPI docs are exposed publicly unless explicitly protected.',
      );
    }
    if (config.STORAGE_DRIVER === 'local' && config.INSTANCE_COUNT_HINT > 1) {
      warnings.push(
        'STORAGE_DRIVER=local with INSTANCE_COUNT_HINT > 1 can cause data inconsistency across instances.',
      );
    }
  }

  return { config, warnings };
}

export function redactConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (SECRET_KEYS.has(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = value;
    }
  }
  return result;
}
