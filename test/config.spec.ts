import {
  validateConfig,
  redactConfig,
  ConfigValidationError,
  SECRET_KEYS,
} from '../src/config/schema.js';
import { AppConfigService } from '../src/config/config.service.js';
import { scanFile } from '../scripts/scan-secrets.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Configuration & Secret Hygiene (P1-02)', () => {
  const baseDevEnv = {
    NODE_ENV: 'development',
    PORT: '7030',
    JWT_SECRET: 'dev-insecure-jwt-secret-do-not-use-in-production-min-32-chars',
    SIGNED_URL_SECRET: 'dev-insecure-signed-url-secret-do-not-use-in-prod',
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_PATH: '/data/storage',
    STAGING_DIR: '/tmp/gus-staging',
  };

  const baseProdEnv = {
    NODE_ENV: 'production',
    PORT: '7030',
    JWT_SECRET:
      'a-very-strong-production-jwt-secret-that-is-over-32-characters-long',
    SIGNED_URL_SECRET:
      'a-distinct-strong-production-signed-url-secret-32-chars',
    ADMIN_AUTH_MODE: 'enforce',
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_PATH: '/data/storage',
    STAGING_DIR: '/tmp/gus-staging',
    EVENT_BROKER: 'memory',
    ALLOW_MEMORY_BROKER: 'true',
    DATABASE_URL: 'postgres://gus:secret_password@postgres.internal:5432/gus',
    SWAGGER_ENABLED: 'false',
  };

  describe('Valid environments', () => {
    it('should validate default development configuration', () => {
      const { config, warnings } = validateConfig(baseDevEnv);
      expect(config.NODE_ENV).toBe('development');
      expect(config.PORT).toBe(7030);
      expect(config.STORAGE_DRIVER).toBe('local');
      expect(warnings).toHaveLength(0);
    });

    it('should validate a full production configuration', () => {
      const { config, warnings } = validateConfig(baseProdEnv);
      expect(config.NODE_ENV).toBe('production');
      expect(config.JWT_SECRET).toBe(baseProdEnv.JWT_SECRET);
      expect(config.SIGNED_URL_SECRET).toBe(baseProdEnv.SIGNED_URL_SECRET);
      expect(warnings).toHaveLength(0);
    });

    it('should support hybrid storage driver with seaweedfs and cloudinary', () => {
      const hybridEnv = {
        ...baseDevEnv,
        STORAGE_DRIVER: 'hybrid',
        HYBRID_PRIMARY: 'seaweedfs',
        HYBRID_PRIMARY_FAILOVER: 'local',
        HYBRID_REPLICAS: 'cloudinary,local',
        SEAWEEDFS_S3_ENDPOINT: 'http://localhost:8333',
        SEAWEEDFS_BUCKET: 'esma-uploads',
        CLOUDINARY_CLOUD_NAME: 'test-cloud',
        CLOUDINARY_API_KEY: 'test-key',
        CLOUDINARY_API_SECRET: 'test-secret',
      };
      const { config } = validateConfig(hybridEnv);
      expect(config.STORAGE_DRIVER).toBe('hybrid');
      expect(config.HYBRID_PRIMARY).toBe('seaweedfs');
    });

    it('should warn when SWAGGER_ENABLED is true in production', () => {
      const prodWithSwagger = {
        ...baseProdEnv,
        SWAGGER_ENABLED: 'true',
      };
      const { warnings } = validateConfig(prodWithSwagger);
      expect(
        warnings.some((w) =>
          w.includes('SWAGGER_ENABLED is true in production'),
        ),
      ).toBe(true);
    });

    it('should warn when STORAGE_DRIVER=local and INSTANCE_COUNT_HINT > 1 in production', () => {
      const prodMultiInstanceLocal = {
        ...baseProdEnv,
        STORAGE_DRIVER: 'local',
        INSTANCE_COUNT_HINT: '3',
      };
      const { warnings } = validateConfig(prodMultiInstanceLocal);
      expect(
        warnings.some((w) =>
          w.includes('STORAGE_DRIVER=local with INSTANCE_COUNT_HINT > 1'),
        ),
      ).toBe(true);
    });
  });

  describe('Invalid environments and fail-fast validation', () => {
    it('should fail when Cloudinary credentials are missing while driver is active', () => {
      const env = {
        ...baseDevEnv,
        STORAGE_DRIVER: 'cloudinary',
        CLOUDINARY_CLOUD_NAME: '',
        CLOUDINARY_API_KEY: '',
        CLOUDINARY_API_SECRET: '',
      };

      expect(() => validateConfig(env)).toThrow(ConfigValidationError);
      try {
        validateConfig(env);
      } catch (err: unknown) {
        const cve = err as ConfigValidationError;
        const fields = cve.issues.map((i) => i.field);
        expect(fields).toContain('CLOUDINARY_CLOUD_NAME');
        expect(fields).toContain('CLOUDINARY_API_KEY');
        expect(fields).toContain('CLOUDINARY_API_SECRET');
      }
    });

    it('should fail when SeaweedFS credentials are missing in production while active', () => {
      const env = {
        ...baseProdEnv,
        STORAGE_DRIVER: 'seaweedfs',
        SEAWEEDFS_S3_ENDPOINT: 'http://localhost:8333',
        SEAWEEDFS_BUCKET: 'uploads',
        SEAWEEDFS_ACCESS_KEY: '',
        SEAWEEDFS_SECRET_KEY: '',
      };

      expect(() => validateConfig(env)).toThrow(ConfigValidationError);
      try {
        validateConfig(env);
      } catch (err: unknown) {
        const cve = err as ConfigValidationError;
        const fields = cve.issues.map((i) => i.field);
        expect(fields).toContain('SEAWEEDFS_ACCESS_KEY');
        expect(fields).toContain('SEAWEEDFS_SECRET_KEY');
      }
    });

    it('should fail when EVENT_BROKER=kafka but KAFKA_BROKERS is missing', () => {
      const env = {
        ...baseDevEnv,
        EVENT_BROKER: 'kafka',
        KAFKA_BROKERS: '',
      };
      expect(() => validateConfig(env)).toThrow(ConfigValidationError);
    });

    it('should fail when EVENT_BROKER=pulsar but PULSAR_SERVICE_URL is missing', () => {
      const env = {
        ...baseDevEnv,
        EVENT_BROKER: 'pulsar',
        PULSAR_SERVICE_URL: '',
      };
      expect(() => validateConfig(env)).toThrow(ConfigValidationError);
    });

    it('should fail when EVENT_BROKER=memory in production without ALLOW_MEMORY_BROKER=true', () => {
      const env = {
        ...baseProdEnv,
        EVENT_BROKER: 'memory',
        ALLOW_MEMORY_BROKER: 'false',
      };
      expect(() => validateConfig(env)).toThrow(ConfigValidationError);
    });

    it('should fail when JWT_SECRET is less than 32 characters in production', () => {
      const env = {
        ...baseProdEnv,
        JWT_SECRET: 'short-secret-under-32-chars',
      };
      expect(() => validateConfig(env)).toThrow(ConfigValidationError);
    });

    it('should fail when SIGNED_URL_SECRET equals JWT_SECRET in production', () => {
      const secret = 'identical-secret-value-that-is-over-32-characters-long';
      const env = {
        ...baseProdEnv,
        JWT_SECRET: secret,
        SIGNED_URL_SECRET: secret,
      };
      expect(() => validateConfig(env)).toThrow(ConfigValidationError);
    });

    it('should fail when ADMIN_AUTH_MODE is off in production', () => {
      const env = {
        ...baseProdEnv,
        ADMIN_AUTH_MODE: 'off',
      };
      expect(() => validateConfig(env)).toThrow(ConfigValidationError);
    });

    it('should fail when LOCAL_STORAGE_PATH overlaps with STAGING_DIR', () => {
      const envEqual = {
        ...baseDevEnv,
        LOCAL_STORAGE_PATH: '/var/data/storage',
        STAGING_DIR: '/var/data/storage',
      };
      expect(() => validateConfig(envEqual)).toThrow(ConfigValidationError);

      const envSub = {
        ...baseDevEnv,
        LOCAL_STORAGE_PATH: '/var/data/storage/sub',
        STAGING_DIR: '/var/data/storage',
      };
      expect(() => validateConfig(envSub)).toThrow(ConfigValidationError);
    });

    it('should collect ALL errors simultaneously and never leak secret values in error text', () => {
      const multiErrorEnv = {
        NODE_ENV: 'production',
        PORT: 'invalid-port',
        JWT_SECRET: 'leaked_super_secret_raw_token_that_is_too_short',
        SIGNED_URL_SECRET: 'leaked_super_secret_raw_token_that_is_too_short',
        ADMIN_AUTH_MODE: 'off',
        EVENT_BROKER: 'memory',
        ALLOW_MEMORY_BROKER: 'false',
        STORAGE_DRIVER: 'local',
        LOCAL_STORAGE_PATH: '/tmp/overlap',
        STAGING_DIR: '/tmp/overlap',
      };

      try {
        validateConfig(multiErrorEnv);
        fail('Expected validateConfig to throw ConfigValidationError');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ConfigValidationError);
        const cve = err as ConfigValidationError;
        // Verify multiple issues collected at once
        expect(cve.issues.length).toBeGreaterThanOrEqual(4);
        const errorText = cve.message;

        // Verify the raw secret value is NEVER printed
        expect(errorText).not.toContain('leaked_super_secret_raw_token');
        expect(errorText).toContain('CONFIGURATION ERROR');
      }
    });
  });

  describe('Redaction and AppConfigService', () => {
    it('should redact all sensitive keys in toSafeObject()', () => {
      const service = new AppConfigService({
        ...baseDevEnv,
        JWT_SECRET: 'very-secret-jwt-key',
        JWT_KEYS:
          '[{"kid":"k1","secret":"very-secret-jwt-key-at-least-32-chars","status":"active"}]',
        SIGNED_URL_SECRET: 'very-secret-signed-url-key',
        DATABASE_URL: 'postgres://app:db_password_123@db.prod:5432/app',
        REDIS_URL: 'redis://:redis_password_xyz@redis.prod:6379',
        CLOUDINARY_API_KEY: 'sensitive-api-key',
        CLOUDINARY_API_SECRET: 'sensitive-api-secret',
        SEAWEEDFS_ACCESS_KEY: 'sensitive-seaweed-key',
        SEAWEEDFS_SECRET_KEY: 'sensitive-seaweed-secret',
        PULSAR_AUTH_TOKEN: 'sensitive-pulsar-token',
      });

      const safe = service.toSafeObject();

      for (const secretKey of SECRET_KEYS) {
        expect(safe[secretKey]).toBe('[REDACTED]');
      }

      // Non-sensitive keys remain visible
      expect(safe.PORT).toBe(7030);
      expect(safe.NODE_ENV).toBe('development');
      expect(safe.STORAGE_DRIVER).toBe('local');
    });

    it('should directly redact records using redactConfig helper', () => {
      const input = {
        JWT_SECRET: 'super-secret',
        PORT: 7030,
      };
      const safe = redactConfig(input);
      expect(safe.JWT_SECRET).toBe('[REDACTED]');
      expect(safe.PORT).toBe(7030);
    });

    it('should expose typed getters', () => {
      const service = new AppConfigService(baseDevEnv);
      expect(service.port).toBe(7030);
      expect(service.nodeEnv).toBe('development');
      expect(service.isProduction()).toBe(false);
      expect(service.isTest()).toBe(false);
      expect(service.isDevelopment()).toBe(true);
      expect(service.trustProxy).toBe('loopback');
    });
  });

  describe('Secret Scanner', () => {
    it('should pass cleanly on a clean source file', () => {
      const cleanPath = path.resolve(__dirname, '../src/config/schema.ts');
      const findings = scanFile(cleanPath);
      expect(findings).toHaveLength(0);
    });

    it('should detect simulated high-entropy leaked secrets and fail', () => {
      const tempFile = path.join(os.tmpdir(), `secret-test-${Date.now()}.ts`);
      try {
        const fakeKey = ['9a8b7c6d', '5e4f3a2b', '1c0d9e8f', '7a6b5c4d'].join(
          '',
        );
        fs.writeFileSync(
          tempFile,
          `const API_` + `SECRET = "${fakeKey}";\n`,
          'utf8',
        );
        const findings = scanFile(tempFile);
        expect(findings.length).toBeGreaterThan(0);
        expect(findings[0].rule).toBe('Generic High-Entropy Secret Assignment');
      } finally {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      }
    });
  });
});
