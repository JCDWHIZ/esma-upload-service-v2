import { Test, TestingModule } from '@nestjs/testing';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { JwtVerifierService } from '../src/auth/jwt/jwt-verifier.service.js';
import { AppConfigService } from '../src/config/config.service.js';
import { UnauthenticatedError } from '../src/core/errors/app-error.js';

describe('JwtVerifierService (P1-09)', () => {
  let verifier: JwtVerifierService;
  const devSecret = 'super-secret-key-that-is-at-least-32-chars-long';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtVerifierService,
        {
          provide: AppConfigService,
          useValue: {
            get: () => ({
              JWT_SECRET: devSecret,
              JWT_ALGORITHMS: 'HS256,RS256',
              JWT_CLOCK_TOLERANCE_SECONDS: 2,
              IDENTITY_JWKS_URI:
                'https://api.esma.elsoft.ng/identity/oauth2/jwks',
              IDENTITY_ISSUER: 'http://esma-identity-service:7071/identity',
            }),
          },
        },
      ],
    }).compile();

    verifier = module.get<JwtVerifierService>(JwtVerifierService);
  });

  describe('HS256 Token Verification', () => {
    it('verifies a valid token signed with the default secret', async () => {
      const secretBytes = new TextEncoder().encode(devSecret);
      const token = await new SignJWT({
        userId: 'user-123',
        organizationId: 'sch-456',
        role: 'TEACHER',
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('user-123')
        .setExpirationTime('1h')
        .setIssuedAt()
        .sign(secretBytes);

      const claims = await verifier.verifyToken(token);
      expect(claims.sub).toBe('user-123');
      expect(claims.userId).toBe('user-123');
      expect(claims.organizationId).toBe('sch-456');
      expect(claims.roles).toEqual(['TEACHER']);
    });

    it('rejects a token signed with the wrong secret', async () => {
      const wrongSecretBytes = new TextEncoder().encode(
        'another-different-secret-key-at-least-32-chars',
      );
      const token = await new SignJWT({ userId: 'user-123' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('user-123')
        .setExpirationTime('1h')
        .sign(wrongSecretBytes);

      await expect(verifier.verifyToken(token)).rejects.toThrow(
        UnauthenticatedError,
      );
    });

    it('rejects an expired token', async () => {
      const secretBytes = new TextEncoder().encode(devSecret);
      const token = await new SignJWT({ userId: 'user-123' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('user-123')
        .setExpirationTime('1s') // expired
        .sign(secretBytes);

      // wait past expiration + tolerance
      await new Promise((resolve) => setTimeout(resolve, 3100));

      await expect(verifier.verifyToken(token)).rejects.toThrow(
        UnauthenticatedError,
      );
    }, 10000);

    it('rejects a token without exp claim (Assumption A-02)', async () => {
      const secretBytes = new TextEncoder().encode(devSecret);
      const token = await new SignJWT({ userId: 'user-123' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('user-123')
        // no setExpirationTime
        .sign(secretBytes);

      await expect(verifier.verifyToken(token)).rejects.toThrow(
        /missing mandatory "exp" expiration claim/,
      );
    });

    it('rejects tokens using algorithm "none" or unsupported algorithms', async () => {
      // Craft a header with alg: 'none'
      const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString(
        'base64url',
      );
      const payload = Buffer.from(
        JSON.stringify({
          sub: 'user-1',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url');
      const noneToken = `${header}.${payload}.`;

      await expect(verifier.verifyToken(noneToken)).rejects.toThrow(
        /Algorithm "none" is forbidden/,
      );
    });

    it('rejects a token without sub or userId claim', async () => {
      const secretBytes = new TextEncoder().encode(devSecret);
      const token = await new SignJWT({ email: 'test@example.com' })
        .setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime('1h')
        .sign(secretBytes);

      await expect(verifier.verifyToken(token)).rejects.toThrow(
        /missing mandatory "sub" or "userId" claim/,
      );
    });
  });

  describe('Key Ring Zero-Downtime Rotation Drill', () => {
    const keyOld = 'key-old-secret-value-32-chars-long-here';
    const keyNew = 'key-new-secret-value-32-chars-long-here';

    it('verifies tokens signed with old key when in verify-only mode, and fails when removed', async () => {
      // Phase 1: Key ring contains keyOld (verify-only) and keyNew (active)
      verifier.setKeyRing([
        { kid: 'key-2', secret: keyNew, status: 'active' },
        { kid: 'key-1', secret: keyOld, status: 'verify-only' },
      ]);

      const tokenOld = await new SignJWT({ userId: 'user-old' })
        .setProtectedHeader({ alg: 'HS256', kid: 'key-1' })
        .setSubject('user-old')
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(keyOld));

      const tokenNew = await new SignJWT({ userId: 'user-new' })
        .setProtectedHeader({ alg: 'HS256', kid: 'key-2' })
        .setSubject('user-new')
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(keyNew));

      // Both should verify successfully during transition
      const claimsOld = await verifier.verifyToken(tokenOld);
      expect(claimsOld.sub).toBe('user-old');

      const claimsNew = await verifier.verifyToken(tokenNew);
      expect(claimsNew.sub).toBe('user-new');

      // Phase 2: keyOld is retired and removed from ring
      verifier.setKeyRing([{ kid: 'key-2', secret: keyNew, status: 'active' }]);

      // tokenNew still succeeds
      await expect(verifier.verifyToken(tokenNew)).resolves.toBeDefined();

      // tokenOld now strictly FAILS
      await expect(verifier.verifyToken(tokenOld)).rejects.toThrow(
        UnauthenticatedError,
      );
    });

    it('supports key ring fallback when token header does not include kid', async () => {
      verifier.setKeyRing([
        { kid: 'active-key', secret: keyNew, status: 'active' },
        { kid: 'old-key', secret: keyOld, status: 'verify-only' },
      ]);

      // Token signed with old key, but no 'kid' in header
      const tokenOldWithoutKid = await new SignJWT({ userId: 'user-legacy' })
        .setProtectedHeader({ alg: 'HS256' }) // no kid
        .setSubject('user-legacy')
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(keyOld));

      // Should fall through active to verify-only key and succeed
      const claims = await verifier.verifyToken(tokenOldWithoutKid);
      expect(claims.sub).toBe('user-legacy');
    });
  });

  describe('OIDC JWKS (RS256) Verification', () => {
    it('verifies a token signed by an RS256 key pair matching mock JWKS resolver', async () => {
      // Generate a test RSA key pair
      const { publicKey, privateKey } = await generateKeyPair('RS256', {
        extractable: true,
      });

      const publicJwk = await exportJWK(publicKey);
      publicJwk.kid = 'test-rsa-kid-1';
      publicJwk.alg = 'RS256';
      publicJwk.use = 'sig';

      // Mock JWKS resolver returning public key
      verifier.setJwksResolver(() => Promise.resolve(publicKey));

      const token = await new SignJWT({
        userId: 'admin-oidc-1',
        organizationId: 'sch-admin-org',
        access: {
          organization: {
            roles: ['SUPER ADMIN'],
            permissions: ['DASHBOARD_VIEW'],
          },
        },
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-rsa-kid-1' })
        .setIssuer('http://esma-identity-service:7071/identity')
        .setSubject('admin-oidc-1')
        .setExpirationTime('1h')
        .setIssuedAt()
        .sign(privateKey);

      const claims = await verifier.verifyToken(token);
      expect(claims.sub).toBe('admin-oidc-1');
      expect(claims.userId).toBe('admin-oidc-1');
      expect(claims.access?.organization?.roles).toEqual(['SUPER ADMIN']);
    });

    it('rejects RS256 token when issuer does not match configured issuer', async () => {
      const { publicKey, privateKey } = await generateKeyPair('RS256', {
        extractable: true,
      });

      verifier.setJwksResolver(() => Promise.resolve(publicKey));

      const token = await new SignJWT({ userId: 'admin-wrong-iss' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-rsa-kid-1' })
        .setIssuer('https://malicious-issuer.com/identity')
        .setSubject('admin-wrong-iss')
        .setExpirationTime('1h')
        .sign(privateKey);

      await expect(verifier.verifyToken(token)).rejects.toThrow(
        UnauthenticatedError,
      );
    });
  });
});
