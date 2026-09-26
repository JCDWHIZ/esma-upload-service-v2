import { Module } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { EsmaTenantContextResolver } from './resolvers/tenant-context.resolver.js';
import { EsmaAdminContextResolver } from './resolvers/admin-context.resolver.js';
import { GenericContextResolver } from './resolvers/generic-context.resolver.js';
import { ContextGuard } from './guards/context.guard.js';

@Module({
  providers: [
    AuthService,
    EsmaTenantContextResolver,
    EsmaAdminContextResolver,
    GenericContextResolver,
    ContextGuard,
  ],
  exports: [
    AuthService,
    EsmaTenantContextResolver,
    EsmaAdminContextResolver,
    GenericContextResolver,
    ContextGuard,
  ],
})
export class AuthModule {}
