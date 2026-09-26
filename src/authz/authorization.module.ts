import { Module } from '@nestjs/common';
import { AuthorizationService } from './authorization.service.js';
import { AuthorizationGuard } from './guards/authorization.guard.js';
import {
  FileResourceLoader,
  DefaultResourceLoader,
} from './resource-loader.js';
import { AUDIT_SINK, NoopAuditSink } from './audit-sink.js';

@Module({
  providers: [
    AuthorizationService,
    FileResourceLoader,
    DefaultResourceLoader,
    AuthorizationGuard,
    {
      provide: AUDIT_SINK,
      useClass: NoopAuditSink,
    },
  ],
  exports: [
    AuthorizationService,
    FileResourceLoader,
    DefaultResourceLoader,
    AuthorizationGuard,
    AUDIT_SINK,
  ],
})
export class AuthorizationModule {}
