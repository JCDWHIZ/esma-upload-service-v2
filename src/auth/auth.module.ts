import { Module, Global } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service.js';
import { EsmaTenantContextResolver } from './resolvers/tenant-context.resolver.js';
import { EsmaAdminContextResolver } from './resolvers/admin-context.resolver.js';
import { GenericContextResolver } from './resolvers/generic-context.resolver.js';
import { ContextGuard } from './guards/context.guard.js';
import { JwtVerifierService } from './jwt/jwt-verifier.service.js';
import { ApiKeyAuthenticatorService } from './apikey/apikey-authenticator.service.js';
import { AuthGuard } from './guards/auth.guard.js';

import { RevocationService } from './revocation.service.js';

@Global()
@Module({
  providers: [
    AuthService,
    JwtVerifierService,
    ApiKeyAuthenticatorService,
    RevocationService,
    AuthGuard,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    EsmaTenantContextResolver,
    EsmaAdminContextResolver,
    GenericContextResolver,
    ContextGuard,
  ],
  exports: [
    AuthService,
    JwtVerifierService,
    ApiKeyAuthenticatorService,
    RevocationService,
    AuthGuard,
    EsmaTenantContextResolver,
    EsmaAdminContextResolver,
    GenericContextResolver,
    ContextGuard,
  ],
})
export class AuthModule {}
