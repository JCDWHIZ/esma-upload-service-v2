import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
  UseFilters,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiSecurity,
  ApiParam,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/guards/auth.guard.js';
import { ContextGuard } from '../auth/guards/context.guard.js';
import { AuthorizationGuard } from '../authz/guards/authorization.guard.js';
import { Accept } from '../auth/decorators/accept.decorator.js';
import { RequireAction } from '../authz/decorators/require-action.decorator.js';
import { ProblemJsonErrorFilter } from '../common/filters/problem-json-error.filter.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { UsageRepository } from '../db/repositories/usage.repository.js';
import { TenantUsageReconciler } from './tenant-usage-reconciler.service.js';
import {
  quotaPatchBodySchema,
  QuotaPatchBodyDto,
} from './dto/quota.dto.js';

@ApiTags('admin-quota')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller('api/v1/admin/tenants/:tenantId')
@UseGuards(AuthGuard, ContextGuard, AuthorizationGuard)
@UseFilters(ProblemJsonErrorFilter)
@Accept('admin-jwt', 'bearer-jwt', 'api-key')
@RequireAction('admin')
export class QuotaController {
  constructor(
    private readonly usageRepo: UsageRepository,
    private readonly reconciler: TenantUsageReconciler,
  ) {}

  @Get('quota')
  @ApiOperation({ summary: 'Get quota and current storage usage for a tenant' })
  @ApiParam({ name: 'tenantId', description: 'Tenant UUID or identifier' })
  @ApiQuery({
    name: 'namespace',
    required: false,
    description: 'Target namespace (defaults to "generic")',
    example: 'generic',
  })
  @ApiResponse({ status: 200, description: 'Tenant storage usage and quota' })
  async getQuota(
    @Param('tenantId') tenantId: string,
    @Query('namespace') namespace = 'generic',
  ) {
    const usage = await this.usageRepo.get(namespace, tenantId);
    return {
      namespace,
      tenantId,
      bytesUsed: usage ? String(usage.bytesUsed) : '0',
      fileCount: usage ? String(usage.fileCount) : '0',
      maxBytes:
        usage?.maxBytes !== null && usage?.maxBytes !== undefined
          ? String(usage.maxBytes)
          : null,
      maxFiles:
        usage?.maxFiles !== null && usage?.maxFiles !== undefined
          ? String(usage.maxFiles)
          : null,
      updatedAt: usage?.updatedAt ?? new Date(),
    };
  }

  @Patch('quota')
  @ApiOperation({ summary: 'Update storage quota for a tenant' })
  @ApiParam({ name: 'tenantId', description: 'Tenant UUID or identifier' })
  @ApiBody({ type: QuotaPatchBodyDto, required: true })
  @ApiResponse({ status: 200, description: 'Updated tenant quota record' })
  async setQuota(
    @Param('tenantId') tenantId: string,
    @Body(new ZodValidationPipe(quotaPatchBodySchema)) body: QuotaPatchBodyDto,
  ) {
    const namespace = body.namespace ?? 'generic';
    const updated = await this.usageRepo.setQuota(
      namespace,
      tenantId,
      body.maxBytes ?? null,
      body.maxFiles ?? null,
    );

    return {
      message: 'Quota updated successfully',
      quota: {
        namespace,
        tenantId,
        bytesUsed: String(updated.bytesUsed),
        fileCount: String(updated.fileCount),
        maxBytes: updated.maxBytes !== null ? String(updated.maxBytes) : null,
        maxFiles: updated.maxFiles !== null ? String(updated.maxFiles) : null,
        updatedAt: updated.updatedAt,
      },
    };
  }

  @Post('reconcile')
  @ApiOperation({
    summary: 'Trigger storage usage drift reconciliation for a tenant',
  })
  @ApiParam({ name: 'tenantId', description: 'Tenant UUID or identifier' })
  @ApiQuery({
    name: 'namespace',
    required: false,
    description: 'Target namespace (defaults to "generic")',
    example: 'generic',
  })
  @ApiResponse({ status: 200, description: 'Reconciliation results' })
  async reconcile(
    @Param('tenantId') tenantId: string,
    @Query('namespace') namespace = 'generic',
  ) {
    const res = await this.reconciler.reconcileTenant(namespace, tenantId);
    return {
      message: res.reconciled
        ? 'Tenant usage drift detected and reconciled'
        : 'Tenant usage is in sync',
      result: {
        ...res,
        recordedBytes: String(res.recordedBytes),
        actualBytes: String(res.actualBytes),
        driftBytes: String(res.driftBytes),
        recordedFileCount: String(res.recordedFileCount),
        actualFileCount: String(res.actualFileCount),
        driftFileCount: String(res.driftFileCount),
      },
    };
  }
}
