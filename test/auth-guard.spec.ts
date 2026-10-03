/* eslint-disable @typescript-eslint/unbound-method */
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '../src/auth/guards/auth.guard.js';
import { JwtVerifierService } from '../src/auth/jwt/jwt-verifier.service.js';
import { ApiKeyAuthenticatorService } from '../src/auth/apikey/apikey-authenticator.service.js';
import { AppConfigService } from '../src/config/config.service.js';
import {
  ForbiddenError,
  UnauthenticatedError,
} from '../src/core/errors/app-error.js';
import { ApiClient } from '../src/core/types.js';
import {
  AuthenticatedHttpRequest,
  VerifiedTokenClaims,
} from '../src/auth/context.js';

describe('AuthGuard (P1-09)', () => {
  let guard: AuthGuard;
  let reflector: jest.Mocked<Reflector>;
  let jwtVerifier: jest.Mocked<JwtVerifierService>;
  let apiKeyAuthenticator: jest.Mocked<ApiKeyAuthenticatorService>;
  let configService: jest.Mocked<AppConfigService>;

  const mockClient: ApiClient = {
    id: 'client-1',
    name: 'test-service',
    keyPrefix: '11223344',
    keyHash: 'hash',
    namespace: 'generic',
    tenantIds: ['tenant-1'],
    allowAnyTenant: false,
    scopes: ['files:read'],
    status: 'ACTIVE',
    expiresAt: null,
    lastUsedAt: null,
    createdAt: new Date(),
    revokedAt: null,
  };

  const mockToken: VerifiedTokenClaims = {
    sub: 'user-1',
    userId: 'user-1',
    organizationId: 'sch-100',
    schoolId: 'sch-100',
    role: 'TEACHER',
    roles: ['TEACHER'],
  };

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    } as unknown as jest.Mocked<Reflector>;

    jwtVerifier = {
      verifyToken: jest.fn().mockResolvedValue(mockToken),
    } as unknown as jest.Mocked<JwtVerifierService>;

    apiKeyAuthenticator = {
      authenticate: jest.fn().mockResolvedValue(mockClient),
    } as unknown as jest.Mocked<ApiKeyAuthenticatorService>;

    configService = {
      get: jest.fn().mockReturnValue({
        ADMIN_ALLOWED_ROLES: 'superadmin,platform_admin',
      }),
    } as unknown as jest.Mocked<AppConfigService>;

    guard = new AuthGuard(
      reflector,
      jwtVerifier,
      apiKeyAuthenticator,
      configService,
    );
  });

  function createMockContext(headers: Record<string, string> = {}): {
    context: ExecutionContext;
    req: AuthenticatedHttpRequest;
  } {
    const req = {
      headers,
      ip: '127.0.0.1',
    } as unknown as AuthenticatedHttpRequest;

    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => req,
      }),
    } as unknown as ExecutionContext;

    return { context, req };
  }

  it('allows access unconditionally when route or controller is marked @Public', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(true); // isPublic = true

    const { context } = createMockContext();
    const allowed = await guard.canActivate(context);

    expect(allowed).toBe(true);
    expect(jwtVerifier.verifyToken).not.toHaveBeenCalled();
    expect(apiKeyAuthenticator.authenticate).not.toHaveBeenCalled();
  });

  it('throws UnauthenticatedError when no credentials are provided on protected route', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined); // not public, default accept

    const { context } = createMockContext({});
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthenticatedError,
    );
  });

  it('authenticates a valid Bearer JWT and sets req.principal & req.user', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    const { context, req } = createMockContext({
      authorization: 'Bearer valid.jwt.token',
    });

    const allowed = await guard.canActivate(context);
    expect(allowed).toBe(true);
    expect(jwtVerifier.verifyToken).toHaveBeenCalledWith('valid.jwt.token');
    expect(req.principal).toEqual(mockToken);
    expect(req.user).toEqual(mockToken);
  });

  it('authenticates a valid API key via x-api-key and sets req.principal & req.apiClient', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    const { context, req } = createMockContext({
      'x-api-key': 'eus2_11223344_secret',
    });

    const allowed = await guard.canActivate(context);
    expect(allowed).toBe(true);
    expect(apiKeyAuthenticator.authenticate).toHaveBeenCalledWith(
      'eus2_11223344_secret',
      '127.0.0.1',
    );
    expect(req.principal).toEqual(mockClient);
    expect(req.apiClient).toEqual(mockClient);
  });

  it('authenticates an API key sent in Authorization: Bearer eus2_... header', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    const { context, req } = createMockContext({
      authorization: 'Bearer eus2_11223344_secret',
    });

    const allowed = await guard.canActivate(context);
    expect(allowed).toBe(true);
    expect(apiKeyAuthenticator.authenticate).toHaveBeenCalledWith(
      'eus2_11223344_secret',
      '127.0.0.1',
    );
    expect(req.principal).toEqual(mockClient);
  });

  describe('@Accept() Restrictions', () => {
    it('denies an API key when route only accepts school-jwt', async () => {
      reflector.getAllAndOverride
        .mockReturnValueOnce(false) // isPublic
        .mockReturnValueOnce(['school-jwt']); // accepted

      const { context } = createMockContext({
        'x-api-key': 'eus2_11223344_secret',
      });

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenError);
    });

    it('denies a school JWT when route strictly requires admin-jwt', async () => {
      reflector.getAllAndOverride
        .mockReturnValueOnce(false) // isPublic
        .mockReturnValueOnce(['admin-jwt']); // accepted

      // mockToken has role TEACHER (not superadmin)
      const { context } = createMockContext({
        authorization: 'Bearer non.admin.jwt',
      });

      await expect(guard.canActivate(context)).rejects.toThrow(
        /Administrator privileges required/,
      );
    });

    it('allows an admin JWT when route strictly requires admin-jwt', async () => {
      reflector.getAllAndOverride
        .mockReturnValueOnce(false) // isPublic
        .mockReturnValueOnce(['admin-jwt']); // accepted

      jwtVerifier.verifyToken.mockResolvedValueOnce({
        sub: 'admin-1',
        roles: ['SUPERADMIN'],
      });

      const { context } = createMockContext({
        authorization: 'Bearer admin.jwt',
      });

      const allowed = await guard.canActivate(context);
      expect(allowed).toBe(true);
    });
  });
});
