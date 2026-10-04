import { Controller, Get, Query, UseGuards, UseFilters } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/guards/auth.guard.js';
import { ContextGuard } from '../auth/guards/context.guard.js';
import { AuthorizationGuard } from '../authz/guards/authorization.guard.js';
import { Accept } from '../auth/decorators/accept.decorator.js';
import { RequireAction } from '../authz/decorators/require-action.decorator.js';
import { ProblemJsonErrorFilter } from '../common/filters/problem-json-error.filter.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { AuditRepository } from '../db/repositories/audit.repository.js';
import { auditListQuerySchema, type AuditListQuery } from './dto/audit.dto.js';
import type { AuditFilter } from '../core/types.js';

@ApiTags('admin-audit')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller('api/v1/admin/audit')
@UseGuards(AuthGuard, ContextGuard, AuthorizationGuard)
@UseFilters(ProblemJsonErrorFilter)
@Accept('admin-jwt', 'bearer-jwt', 'api-key')
@RequireAction('admin')
export class AuditController {
  constructor(private readonly auditRepo: AuditRepository) {}

  @Get()
  @ApiOperation({
    summary: 'Query audit log entries with filters and keyset pagination',
    description:
      'Retrieve system and security audit logs filtered by namespace, tenant, actor, file, action, outcome, or time range.',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of audit log records',
  })
  async list(
    @Query(new ZodValidationPipe(auditListQuerySchema)) query: AuditListQuery,
  ) {
    const filter: AuditFilter = {
      namespace: query.namespace,
      tenantId: query.tenantId,
      actorId: query.actorId,
      fileId: query.fileId,
      action: query.action,
      outcome: query.outcome,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    };

    return this.auditRepo.query(filter, query.cursor, query.limit ?? 50);
  }
}
