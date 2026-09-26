import { Test, TestingModule } from '@nestjs/testing';
import * as crypto from 'node:crypto';
import { ApiKeyAuthenticatorService } from '../src/auth/apikey/apikey-authenticator.service.js';
import { ApiClientRepository } from '../src/db/repositories/api-client.repository.js';
import {
  RateLimitedError,
  UnauthenticatedError,
} from '../src/core/errors/app-error.js';
import { ApiClient } from '../src/core/types.js';

describe('ApiKeyAuthenticatorService (P1-09)', () => {
  let authenticator: ApiKeyAuthenticatorService;
  let mockApiClientRepo: Partial<jest.Mocked<ApiClientRepository>>;

  const dummyClient: ApiClient = {
    id: 'client-uuid-1',
    name: 'test-client',
    keyPrefix: 'a1b2c3d4',
    keyHash: crypto
      .createHash('sha256')
      .update('valid-secret-token-32-chars-long-here')
      .digest('hex'),
    namespace: 'generic',
    tenantIds: ['tenant-1'],
    allowAnyTenant: false,
    scopes: ['files:read', 'files:write'],
    status: 'ACTIVE',
    expiresAt: new Date(Date.now() + 86_400_000), // tomorrow
    lastUsedAt: null,
    createdAt: new Date(),
    revokedAt: null,
  };

  beforeEach(async () => {
    mockApiClientRepo = {
      findByPrefix: jest.fn().mockImplementation((prefix: string) => {
        if (prefix === dummyClient.keyPrefix) {
          return Promise.resolve({ ...dummyClient });
        }
        return Promise.resolve(null);
      }),
      touchLastUsed: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyAuthenticatorService,
        {
          provide: ApiClientRepository,
          useValue: mockApiClientRepo,
        },
      ],
    }).compile();

    authenticator = module.get<ApiKeyAuthenticatorService>(
      ApiKeyAuthenticatorService,
    );
  });

  describe('Key Generation', () => {
    it('generates a valid key with eus2_ prefix, 8 char hex prefix and 43 char secret', () => {
      const generated = ApiKeyAuthenticatorService.generateKey();
      expect(generated.rawKey).toMatch(/^eus2_[a-f0-9]{8}_[A-Za-z0-9_-]{43}$/);
      expect(generated.keyPrefix).toHaveLength(8);
      expect(generated.keyHash).toHaveLength(64); // SHA-256 hex
    });
  });

  describe('Authentication', () => {
    it('authenticates a valid eus2_ API key and returns the client', async () => {
      const validKey = `eus2_${dummyClient.keyPrefix}_valid-secret-token-32-chars-long-here`;
      const client = await authenticator.authenticate(validKey);

      expect(client.id).toBe(dummyClient.id);
      expect(client.name).toBe(dummyClient.name);
      expect(mockApiClientRepo.findByPrefix).toHaveBeenCalledWith(
        dummyClient.keyPrefix,
      );
    });

    it('also accepts legacy gus_ and eus_ prefixes for compatibility', async () => {
      const gusKey = `gus_${dummyClient.keyPrefix}_valid-secret-token-32-chars-long-here`;
      const client = await authenticator.authenticate(gusKey);
      expect(client.id).toBe(dummyClient.id);

      const eusKey = `eus_${dummyClient.keyPrefix}_valid-secret-token-32-chars-long-here`;
      const client2 = await authenticator.authenticate(eusKey);
      expect(client2.id).toBe(dummyClient.id);
    });

    it('rejects an invalid secret for an existing prefix (timing-safe)', async () => {
      const invalidSecretKey = `eus2_${dummyClient.keyPrefix}_wrong-secret-token-32-chars-long-here`;
      await expect(
        authenticator.authenticate(invalidSecretKey),
      ).rejects.toThrow(UnauthenticatedError);
    });

    it('rejects an unknown key prefix', async () => {
      const unknownKey = 'eus2_99999999_valid-secret-token-32-chars-long-here';
      await expect(authenticator.authenticate(unknownKey)).rejects.toThrow(
        UnauthenticatedError,
      );
    });

    it('rejects malformed key formats', async () => {
      await expect(
        authenticator.authenticate('not-a-valid-key'),
      ).rejects.toThrow(/Invalid API key format/);
      await expect(authenticator.authenticate('')).rejects.toThrow(
        /Missing API key/,
      );
    });

    it('rejects a revoked API key', async () => {
      mockApiClientRepo.findByPrefix = jest.fn().mockResolvedValue({
        ...dummyClient,
        status: 'REVOKED',
      });

      const validKey = `eus2_${dummyClient.keyPrefix}_valid-secret-token-32-chars-long-here`;
      await expect(authenticator.authenticate(validKey)).rejects.toThrow(
        /API key has been revoked/,
      );
    });

    it('rejects an expired API key', async () => {
      mockApiClientRepo.findByPrefix = jest.fn().mockResolvedValue({
        ...dummyClient,
        expiresAt: new Date(Date.now() - 10_000), // expired 10s ago
      });

      const validKey = `eus2_${dummyClient.keyPrefix}_valid-secret-token-32-chars-long-here`;
      await expect(authenticator.authenticate(validKey)).rejects.toThrow(
        /API key has expired/,
      );
    });
  });

  describe('Caching & Throttling', () => {
    it('serves subsequent calls from memory cache within 30 seconds', async () => {
      const validKey = `eus2_${dummyClient.keyPrefix}_valid-secret-token-32-chars-long-here`;

      // 1st call -> hits DB
      await authenticator.authenticate(validKey);
      expect(mockApiClientRepo.findByPrefix).toHaveBeenCalledTimes(1);

      // 2nd call -> served from cache
      await authenticator.authenticate(validKey);
      expect(mockApiClientRepo.findByPrefix).toHaveBeenCalledTimes(1);
    });

    it('caches negative authentication hits for unknown keys', async () => {
      const unknownKey = 'eus2_88888888_random-secret-token-32-chars-long-here';

      // 1st call
      await expect(authenticator.authenticate(unknownKey)).rejects.toThrow(
        UnauthenticatedError,
      );
      expect(mockApiClientRepo.findByPrefix).toHaveBeenCalledTimes(1);

      // 2nd call -> negative cache hit, no DB call
      await expect(authenticator.authenticate(unknownKey)).rejects.toThrow(
        UnauthenticatedError,
      );
      expect(mockApiClientRepo.findByPrefix).toHaveBeenCalledTimes(1);
    });

    it('throttles touchLastUsed to at most once per minute', async () => {
      const validKey = `eus2_${dummyClient.keyPrefix}_valid-secret-token-32-chars-long-here`;

      // First authentication: touchLastUsed called because lastUsedAt was null
      await authenticator.authenticate(validKey);
      expect(mockApiClientRepo.touchLastUsed).toHaveBeenCalledTimes(1);

      // Immediately authenticate again: touchLastUsed should not be called again
      await authenticator.authenticate(validKey);
      expect(mockApiClientRepo.touchLastUsed).toHaveBeenCalledTimes(1);
    });
  });

  describe('Brute Force IP Rate Limiting', () => {
    it('blocks IP after 10 failed attempts within 1 minute', async () => {
      const ip = '198.51.100.25';
      const badKey = 'eus2_00000000_invalid-secret-token-32-chars-long-here';

      // 10 failed attempts
      for (let i = 0; i < 10; i++) {
        await expect(authenticator.authenticate(badKey, ip)).rejects.toThrow(
          UnauthenticatedError,
        );
      }

      // 11th attempt: blocked by rate limiter
      await expect(authenticator.authenticate(badKey, ip)).rejects.toThrow(
        RateLimitedError,
      );
    });
  });
});
