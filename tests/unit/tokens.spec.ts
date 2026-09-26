import { describe, it, expect } from 'vitest';
import { decodeJwt } from 'jose';
import { tokens, signToken, TEST_JWT_SECRET } from '../helpers/tokens.js';
import { JwtVerifierService } from '../../src/auth/jwt/jwt-verifier.service.js';
import { AppConfigService } from '../../src/config/config.service.js';
import { UnauthenticatedError } from '../../src/core/errors/app-error.js';

describe('Token Test Helpers (tokens)', () => {
  const verifier = new JwtVerifierService({
    get: () => ({
      JWT_SECRET: TEST_JWT_SECRET,
      JWT_ALGORITHMS: 'HS256',
      JWT_CLOCK_TOLERANCE_SECONDS: 2,
    }),
  } as unknown as AppConfigService);

  it('signs custom payload with signToken()', async () => {
    const token = await signToken({ foo: 'bar', userId: 'usr-123' });
    const decoded = decodeJwt(token);
    expect(decoded.foo).toBe('bar');
    expect(decoded.userId).toBe('usr-123');
    expect(decoded.exp).toBeDefined();

    const verified = await verifier.verifyToken(token);
    expect(verified.userId).toBe('usr-123');
  });

  it('generates school token with tokens.school()', async () => {
    const token = await tokens.school({ customClaim: 'custom-val' });
    const verified = await verifier.verifyToken(token);
    expect(verified.schoolId).toBe('sch-test-01');
    expect(verified.organizationId).toBe('sch-test-01');
    expect(verified.roles).toContain('school_admin');
  });

  it('generates branch token with tokens.branch()', async () => {
    const token = await tokens.branch();
    const verified = await verifier.verifyToken(token);
    expect(verified.schoolId).toBe('sch-test-01');
    expect(verified.branchId).toBe('br-test-01');
    expect(verified.roles).toContain('branch_admin');
  });

  it('generates admin token with tokens.admin()', async () => {
    const token = await tokens.admin();
    const verified = await verifier.verifyToken(token);
    expect(verified.roles).toContain('superadmin');
  });

  it('generates expired token with tokens.expired() which fails verification', async () => {
    const token = await tokens.expired();
    await expect(verifier.verifyToken(token)).rejects.toThrow(
      UnauthenticatedError,
    );
  });

  it('generates no-exp token with tokens.noExp()', async () => {
    const token = await tokens.noExp();
    const decoded = decodeJwt(token);
    expect(decoded.exp).toBeUndefined();
    expect(decoded.iat).toBeDefined();
  });
});
