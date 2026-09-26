import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppConfigService } from '../../config/config.service.js';
import {
  ForbiddenError,
  UnauthenticatedError,
} from '../../core/errors/app-error.js';
import { JwtVerifierService } from '../jwt/jwt-verifier.service.js';
import { ApiKeyAuthenticatorService } from '../apikey/apikey-authenticator.service.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import {
  ACCEPT_CREDENTIALS_KEY,
  CredentialType,
} from '../decorators/accept.decorator.js';
import { AuthenticatedHttpRequest } from '../context.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtVerifier: JwtVerifierService,
    private readonly apiKeyAuthenticator: ApiKeyAuthenticatorService,
    private readonly configService: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1. Check if route or controller is marked @Public()
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // 2. Determine accepted credential mechanisms
    const accepted = this.reflector.getAllAndOverride<CredentialType[]>(
      ACCEPT_CREDENTIALS_KEY,
      [context.getHandler(), context.getClass()],
    ) ?? ['school-jwt', 'admin-jwt', 'api-key', 'bearer-jwt'];

    const req = context.switchToHttp().getRequest<AuthenticatedHttpRequest>();
    const headers = req.headers ?? {};

    const authHeader = headers['authorization']?.trim();
    const apiKeyHeader = (headers['x-api-key'] as string | undefined)?.trim();

    const clientIp =
      (headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
      req.ip ??
      req.socket?.remoteAddress;

    // 3. Extract credentials
    let extractedApiKey: string | undefined;
    let extractedJwt: string | undefined;

    if (apiKeyHeader) {
      extractedApiKey = apiKeyHeader;
    }

    if (authHeader) {
      if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7).trim();
        if (
          token.startsWith('eus2_') ||
          token.startsWith('eus_') ||
          token.startsWith('gus_')
        ) {
          extractedApiKey = token;
        } else {
          extractedJwt = token;
        }
      } else if (authHeader.startsWith('ApiKey ')) {
        extractedApiKey = authHeader.substring(7).trim();
      }
    }

    if (!extractedApiKey && !extractedJwt) {
      throw new UnauthenticatedError(
        'Authentication required: missing Bearer token or x-api-key header',
      );
    }

    // 4. Authenticate API Key
    if (extractedApiKey) {
      if (!accepted.includes('api-key')) {
        throw new ForbiddenError(
          'API key credentials are not accepted for this endpoint',
        );
      }

      const client = await this.apiKeyAuthenticator.authenticate(
        extractedApiKey,
        clientIp,
      );

      req.principal = client;
      req.apiClient = client;
      return true;
    }

    // 5. Authenticate JWT
    if (extractedJwt) {
      const acceptsJwt =
        accepted.includes('school-jwt') ||
        accepted.includes('admin-jwt') ||
        accepted.includes('bearer-jwt');

      if (!acceptsJwt) {
        throw new ForbiddenError(
          'JWT Bearer tokens are not accepted for this endpoint',
        );
      }

      const claims = await this.jwtVerifier.verifyToken(extractedJwt);

      // Verify specific accepted JWT subtypes if constrained
      if (
        accepted.includes('admin-jwt') &&
        !accepted.includes('school-jwt') &&
        !accepted.includes('bearer-jwt')
      ) {
        const adminAllowedRoles = this.configService
          .get()
          .ADMIN_ALLOWED_ROLES.split(',')
          .map((r) => r.trim().toLowerCase());

        const hasAdminRole =
          claims.roles?.some((r) =>
            adminAllowedRoles.includes(r.toLowerCase()),
          ) ||
          claims.access?.organization?.roles?.some((r) =>
            adminAllowedRoles.includes(r.toLowerCase()),
          );

        if (!claims.platformAdmin && !hasAdminRole) {
          throw new ForbiddenError(
            'Administrator privileges required for this endpoint',
          );
        }
      }

      if (
        accepted.includes('school-jwt') &&
        !accepted.includes('admin-jwt') &&
        !accepted.includes('bearer-jwt')
      ) {
        if (!claims.organizationId && !claims.schoolId) {
          throw new ForbiddenError(
            'School / Tenant credentials required for this endpoint',
          );
        }
      }

      req.principal = claims;
      req.user = claims;
      req.token = claims;
      return true;
    }

    throw new UnauthenticatedError('Authentication failed');
  }
}
